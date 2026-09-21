// UCP Checkout Module
// Handles multi-retailer checkout via the Universal Commerce Protocol
//
// UCP-compatible retailers: Walmart, Target, Etsy, Home Depot, Shopify stores
// Amazon: falls back to multi-item cart URL (not UCP-compatible yet)

const UCP_RETAILERS = {
  walmart: { gateway: 'https://www.walmart.com', name: 'Walmart' },
  target: { gateway: 'https://www.target.com', name: 'Target' },
  etsy: { gateway: 'https://www.etsy.com', name: 'Etsy' },
  'home depot': { gateway: 'https://www.homedepot.com', name: 'Home Depot' },
  michaels: { gateway: 'https://www.michaels.com', name: 'Michaels' },
  'hobby lobby': { gateway: 'https://www.hobbylobby.com', name: 'Hobby Lobby' },
};

const AGENT_PROFILE_URL = process.env.AGENT_PROFILE_URL || 'https://partyplanner.app/.well-known/ucp';

let UCPClientModule = null;

async function getUCPClient() {
  if (!UCPClientModule) {
    UCPClientModule = await import('@omnixhq/ucp-client');
  }
  return UCPClientModule;
}

function matchRetailer(storeName) {
  if (!storeName) return null;
  const lower = storeName.toLowerCase();
  for (const [key, info] of Object.entries(UCP_RETAILERS)) {
    if (lower.includes(key)) return { key, ...info };
  }
  return null;
}

function isAmazon(storeName) {
  return storeName && storeName.toLowerCase().includes('amazon');
}

function buildAmazonCartUrl(items) {
  const params = new URLSearchParams();
  items.forEach((item, i) => {
    const idx = i + 1;
    if (item.asin) {
      params.set(`ASIN.${idx}`, item.asin);
      params.set(`Quantity.${idx}`, String(item.quantity || 1));
    }
  });
  if (params.toString()) {
    return `https://www.amazon.com/gp/aws/cart/add.html?${params.toString()}`;
  }
  return null;
}

function groupItemsByRetailer(items) {
  const groups = { amazon: [], ucp: {}, unsupported: [] };

  for (const item of items) {
    const store = item.store || item.retailer || '';
    if (isAmazon(store)) {
      groups.amazon.push(item);
    } else {
      const retailer = matchRetailer(store);
      if (retailer) {
        if (!groups.ucp[retailer.key]) {
          groups.ucp[retailer.key] = { retailer, items: [] };
        }
        groups.ucp[retailer.key].items.push(item);
      } else {
        groups.unsupported.push(item);
      }
    }
  }

  return groups;
}

async function createUCPCheckout(retailerKey, items, buyerInfo) {
  const retailer = UCP_RETAILERS[retailerKey];
  if (!retailer) {
    return { error: `Unknown retailer: ${retailerKey}`, fallback: true };
  }

  try {
    const { UCPClient } = await getUCPClient();

    const client = await UCPClient.connect({
      gatewayUrl: retailer.gateway,
      agentProfileUrl: AGENT_PROFILE_URL,
    });

    if (!client.checkout) {
      return { error: `${retailer.name} does not support UCP checkout yet`, fallback: true };
    }

    const lineItems = items.map((item, i) => ({
      item: {
        id: item.productId || `item_${i}`,
        title: item.name,
        price: Math.round((item.price || 0) * 100),
      },
      quantity: item.quantity || 1,
    }));

    const session = await client.checkout.create({ line_items: lineItems });

    if (buyerInfo && session.id) {
      const updatePayload = {
        buyer: {
          email: buyerInfo.email,
          first_name: buyerInfo.firstName,
          last_name: buyerInfo.lastName,
        },
        line_items: session.line_items,
      };

      if (buyerInfo.address) {
        updatePayload.fulfillment = {
          methods: [{
            type: 'shipping',
            destinations: [{
              street_address: buyerInfo.address.street,
              address_locality: buyerInfo.address.city,
              address_region: buyerInfo.address.state,
              postal_code: buyerInfo.address.zip,
              address_country: buyerInfo.address.country || 'US',
            }],
          }],
        };
      }

      await client.checkout.update(session.id, updatePayload);
    }

    return {
      sessionId: session.id,
      status: session.status,
      retailer: retailer.name,
      totals: session.totals,
      paymentHandlers: client.paymentHandlers,
    };
  } catch (err) {
    console.error(`[ucp] ${retailer.name} checkout failed:`, err.message);
    return {
      error: `${retailer.name} UCP checkout unavailable: ${err.message}`,
      fallback: true,
      retailer: retailer.name,
    };
  }
}

async function completeUCPCheckout(retailerKey, sessionId, paymentToken) {
  const retailer = UCP_RETAILERS[retailerKey];
  if (!retailer) {
    return { error: `Unknown retailer: ${retailerKey}` };
  }

  try {
    const { UCPClient } = await getUCPClient();

    const client = await UCPClient.connect({
      gatewayUrl: retailer.gateway,
      agentProfileUrl: AGENT_PROFILE_URL,
    });

    if (!client.checkout) {
      return { error: `${retailer.name} does not support UCP checkout` };
    }

    const result = await client.checkout.complete(sessionId, {
      payment: {
        instruments: [{
          id: `pi_${Date.now()}`,
          handler_id: paymentToken.handlerId || 'com.stripe',
          type: 'card',
          selected: true,
          credential: {
            type: 'PAYMENT_GATEWAY',
            token: paymentToken.token,
          },
        }],
      },
    });

    return {
      status: result.status,
      orderId: result.order?.id,
      orderUrl: result.order?.permalink_url,
      retailer: retailer.name,
    };
  } catch (err) {
    console.error(`[ucp] ${retailer.name} complete failed:`, err.message);
    return { error: `${retailer.name} order failed: ${err.message}` };
  }
}

function buildCheckoutPlan(bucketItems) {
  const groups = groupItemsByRetailer(bucketItems);
  const plan = { retailers: [], amazonCartUrl: null, unsupported: [] };

  if (groups.amazon.length > 0) {
    const cartUrl = buildAmazonCartUrl(groups.amazon);
    plan.amazonCartUrl = cartUrl;
    plan.retailers.push({
      key: 'amazon',
      name: 'Amazon',
      method: 'cart_url',
      items: groups.amazon,
      cartUrl,
      total: groups.amazon.reduce((s, it) => s + (it.price || 0) * (it.quantity || 1), 0),
    });
  }

  for (const [key, group] of Object.entries(groups.ucp)) {
    plan.retailers.push({
      key,
      name: group.retailer.name,
      method: 'ucp',
      items: group.items,
      total: group.items.reduce((s, it) => s + (it.price || 0) * (it.quantity || 1), 0),
    });
  }

  plan.unsupported = groups.unsupported;

  return plan;
}

module.exports = {
  buildCheckoutPlan,
  createUCPCheckout,
  completeUCPCheckout,
  groupItemsByRetailer,
  buildAmazonCartUrl,
  UCP_RETAILERS,
};
