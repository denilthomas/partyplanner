// PartyPlanner App - Core Application Logic
// Uses localStorage for persistence

(function () {
  'use strict';

  // ── Data Layer ──

  function loadData() {
    const defaults = { events: [], guests: [], expenses: [], tasks: [] };
    try {
      const raw = localStorage.getItem('partyplanner');
      return raw ? JSON.parse(raw) : defaults;
    } catch {
      return defaults;
    }
  }

  function saveData(data) {
    localStorage.setItem('partyplanner', JSON.stringify(data));
  }

  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  let data = loadData();

  // ── Tab Navigation ──

  const navButtons = document.querySelectorAll('.nav-btn');
  const tabContents = document.querySelectorAll('.tab-content');

  navButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      navButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(t => t.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(target).classList.add('active');
    });
  });

  // ── Modal Helpers ──

  function openModal(id) {
    document.getElementById(id).classList.remove('hidden');
  }

  function closeModal(id) {
    document.getElementById(id).classList.add('hidden');
  }

  document.querySelectorAll('.modal-close, [data-modal]').forEach(el => {
    el.addEventListener('click', () => {
      const modalId = el.dataset.modal;
      if (modalId) closeModal(modalId);
    });
  });

  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal(modal.id);
    });
  });

  // ── Event Type Labels ──

  const eventTypeLabels = {
    birthday: 'Birthday Party',
    wedding: 'Wedding',
    corporate: 'Corporate Event',
    holiday: 'Holiday Party',
    dinner: 'Dinner Party',
    other: 'Other',
  };

  const categoryLabels = {
    venue: 'Venue',
    food: 'Food & Drinks',
    decorations: 'Decorations',
    entertainment: 'Entertainment',
    photography: 'Photography',
    invitations: 'Invitations',
    other: 'Other',
  };

  // ── Format Helpers ──

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function formatTime(timeStr) {
    if (!timeStr) return '';
    const [h, m] = timeStr.split(':');
    const hour = parseInt(h, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const displayHour = hour % 12 || 12;
    return `${displayHour}:${m} ${ampm}`;
  }

  function formatCurrency(amount) {
    return '$' + Number(amount).toFixed(2);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ── Dashboard ──

  function renderDashboard() {
    const now = new Date();
    const upcomingEvents = data.events
      .filter(e => new Date(e.date + 'T' + (e.time || '23:59')) >= now)
      .sort((a, b) => new Date(a.date) - new Date(b.date));

    document.getElementById('stat-events').textContent = upcomingEvents.length;
    document.getElementById('stat-guests').textContent = data.guests.length;

    const totalBudget = data.expenses.reduce((sum, ex) => sum + Number(ex.amount), 0);
    document.getElementById('stat-budget').textContent = formatCurrency(totalBudget);

    const pendingTasks = data.tasks.filter(t => !t.completed).length;
    document.getElementById('stat-tasks').textContent = pendingTasks;

    const listEl = document.getElementById('dashboard-events-list');
    if (upcomingEvents.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No upcoming events. Create one to get started!</p>';
      return;
    }

    listEl.innerHTML = upcomingEvents.slice(0, 5).map(ev => `
      <div class="event-preview-card">
        <div class="event-preview-info">
          <strong>${escapeHtml(ev.name)}</strong>
          <span class="event-type-badge ${ev.type}">${eventTypeLabels[ev.type] || ev.type}</span>
        </div>
        <div class="event-preview-meta">
          <span>${formatDate(ev.date)} at ${formatTime(ev.time)}</span>
          <span>${escapeHtml(ev.location)}</span>
        </div>
      </div>
    `).join('');
  }

  // ── Events CRUD ──

  function renderEvents() {
    const list = document.getElementById('events-list');
    if (data.events.length === 0) {
      list.innerHTML = '<p class="empty-state">No events yet. Click "+ New Event" to create your first party!</p>';
      return;
    }

    const sorted = [...data.events].sort((a, b) => new Date(a.date) - new Date(b.date));
    list.innerHTML = sorted.map(ev => {
      const guestCount = data.guests.filter(g => g.eventId === ev.id).length;
      const spent = data.expenses.filter(ex => ex.eventId === ev.id).reduce((s, ex) => s + Number(ex.amount), 0);
      const taskCount = data.tasks.filter(t => t.eventId === ev.id && !t.completed).length;

      return `
        <div class="card event-card">
          <div class="card-header">
            <h3>${escapeHtml(ev.name)}</h3>
            <span class="event-type-badge ${ev.type}">${eventTypeLabels[ev.type] || ev.type}</span>
          </div>
          <div class="card-body">
            <p><strong>Date:</strong> ${formatDate(ev.date)} at ${formatTime(ev.time)}</p>
            <p><strong>Location:</strong> ${escapeHtml(ev.location)}</p>
            ${ev.description ? `<p class="event-desc">${escapeHtml(ev.description)}</p>` : ''}
            <div class="event-stats">
              <span>${guestCount} guest${guestCount !== 1 ? 's' : ''}</span>
              <span>${formatCurrency(spent)} spent</span>
              <span>${taskCount} task${taskCount !== 1 ? 's' : ''} left</span>
            </div>
          </div>
          <div class="card-actions">
            <button class="btn btn-sm btn-secondary" onclick="app.editEvent('${ev.id}')">Edit</button>
            <button class="btn btn-sm btn-danger" onclick="app.deleteEvent('${ev.id}')">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }

  document.getElementById('add-event-btn').addEventListener('click', () => {
    document.getElementById('event-form').reset();
    document.getElementById('event-id').value = '';
    document.getElementById('event-modal-title').textContent = 'New Event';
    openModal('event-modal');
  });

  document.getElementById('event-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('event-id').value;
    const eventData = {
      name: document.getElementById('event-name').value.trim(),
      date: document.getElementById('event-date').value,
      time: document.getElementById('event-time').value,
      location: document.getElementById('event-location').value.trim(),
      type: document.getElementById('event-type').value,
      description: document.getElementById('event-description').value.trim(),
    };

    if (id) {
      const idx = data.events.findIndex(ev => ev.id === id);
      if (idx !== -1) data.events[idx] = { ...data.events[idx], ...eventData };
    } else {
      data.events.push({ id: generateId(), ...eventData });
    }

    saveData(data);
    closeModal('event-modal');
    renderAll();
  });

  function editEvent(id) {
    const ev = data.events.find(e => e.id === id);
    if (!ev) return;
    document.getElementById('event-id').value = ev.id;
    document.getElementById('event-name').value = ev.name;
    document.getElementById('event-date').value = ev.date;
    document.getElementById('event-time').value = ev.time;
    document.getElementById('event-location').value = ev.location;
    document.getElementById('event-type').value = ev.type;
    document.getElementById('event-description').value = ev.description || '';
    document.getElementById('event-modal-title').textContent = 'Edit Event';
    openModal('event-modal');
  }

  function deleteEvent(id) {
    if (!confirm('Delete this event and all associated guests, expenses, and tasks?')) return;
    data.events = data.events.filter(e => e.id !== id);
    data.guests = data.guests.filter(g => g.eventId !== id);
    data.expenses = data.expenses.filter(ex => ex.eventId !== id);
    data.tasks = data.tasks.filter(t => t.eventId !== id);
    saveData(data);
    renderAll();
  }

  // ── Event Filter Dropdowns ──

  function populateEventFilters() {
    const selects = [
      document.getElementById('guest-event-filter'),
      document.getElementById('budget-event-filter'),
      document.getElementById('task-event-filter'),
    ];

    selects.forEach(sel => {
      const currentVal = sel.value;
      const firstOption = sel.querySelector('option');
      sel.innerHTML = '';
      sel.appendChild(firstOption);
      data.events.forEach(ev => {
        const opt = document.createElement('option');
        opt.value = ev.id;
        opt.textContent = ev.name;
        sel.appendChild(opt);
      });
      if (currentVal && data.events.some(e => e.id === currentVal)) {
        sel.value = currentVal;
      }
    });
  }

  // ── Guests CRUD ──

  const guestEventFilter = document.getElementById('guest-event-filter');
  const addGuestBtn = document.getElementById('add-guest-btn');

  guestEventFilter.addEventListener('change', () => {
    addGuestBtn.disabled = !guestEventFilter.value;
    renderGuests();
  });

  function renderGuests() {
    const eventId = guestEventFilter.value;
    const listEl = document.getElementById('guests-list');
    const summaryEl = document.getElementById('guest-summary');

    if (!eventId) {
      listEl.innerHTML = '<p class="empty-state">Select an event to manage its guest list.</p>';
      summaryEl.classList.add('hidden');
      return;
    }

    const guests = data.guests.filter(g => g.eventId === eventId);
    summaryEl.classList.remove('hidden');

    const confirmed = guests.filter(g => g.rsvp === 'confirmed').length;
    const pending = guests.filter(g => g.rsvp === 'pending').length;
    const declined = guests.filter(g => g.rsvp === 'declined').length;
    document.getElementById('confirmed-count').textContent = `${confirmed} Confirmed`;
    document.getElementById('pending-count').textContent = `${pending} Pending`;
    document.getElementById('declined-count').textContent = `${declined} Declined`;

    if (guests.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No guests added yet. Click "+ Add Guest" to start your guest list.</p>';
      return;
    }

    listEl.innerHTML = `
      <table class="guests-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>RSVP</th>
            <th>Dietary</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${guests.map(g => `
            <tr>
              <td>${escapeHtml(g.name)}</td>
              <td>${escapeHtml(g.email || '-')}</td>
              <td><span class="rsvp-badge rsvp-${g.rsvp}">${g.rsvp}</span></td>
              <td>${escapeHtml(g.dietary || '-')}</td>
              <td class="actions-cell">
                <button class="btn btn-sm btn-secondary" onclick="app.editGuest('${g.id}')">Edit</button>
                <button class="btn btn-sm btn-danger" onclick="app.deleteGuest('${g.id}')">Delete</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  addGuestBtn.addEventListener('click', () => {
    document.getElementById('guest-form').reset();
    document.getElementById('guest-id').value = '';
    document.getElementById('guest-event-id').value = guestEventFilter.value;
    document.getElementById('guest-modal-title').textContent = 'Add Guest';
    openModal('guest-modal');
  });

  document.getElementById('guest-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('guest-id').value;
    const guestData = {
      eventId: document.getElementById('guest-event-id').value,
      name: document.getElementById('guest-name').value.trim(),
      email: document.getElementById('guest-email').value.trim(),
      rsvp: document.getElementById('guest-rsvp').value,
      dietary: document.getElementById('guest-dietary').value.trim(),
    };

    if (id) {
      const idx = data.guests.findIndex(g => g.id === id);
      if (idx !== -1) data.guests[idx] = { ...data.guests[idx], ...guestData };
    } else {
      data.guests.push({ id: generateId(), ...guestData });
    }

    saveData(data);
    closeModal('guest-modal');
    renderAll();
  });

  function editGuest(id) {
    const g = data.guests.find(g => g.id === id);
    if (!g) return;
    document.getElementById('guest-id').value = g.id;
    document.getElementById('guest-event-id').value = g.eventId;
    document.getElementById('guest-name').value = g.name;
    document.getElementById('guest-email').value = g.email || '';
    document.getElementById('guest-rsvp').value = g.rsvp;
    document.getElementById('guest-dietary').value = g.dietary || '';
    document.getElementById('guest-modal-title').textContent = 'Edit Guest';
    openModal('guest-modal');
  }

  function deleteGuest(id) {
    if (!confirm('Remove this guest?')) return;
    data.guests = data.guests.filter(g => g.id !== id);
    saveData(data);
    renderAll();
  }

  // ── Budget / Expenses CRUD ──

  const budgetEventFilter = document.getElementById('budget-event-filter');
  const addExpenseBtn = document.getElementById('add-expense-btn');

  budgetEventFilter.addEventListener('change', () => {
    addExpenseBtn.disabled = !budgetEventFilter.value;
    renderExpenses();
  });

  function renderExpenses() {
    const eventId = budgetEventFilter.value;
    const listEl = document.getElementById('expenses-list');
    const overviewEl = document.getElementById('budget-overview');

    if (!eventId) {
      listEl.innerHTML = '<p class="empty-state">Select an event to manage its budget.</p>';
      overviewEl.classList.add('hidden');
      return;
    }

    const expenses = data.expenses.filter(ex => ex.eventId === eventId);
    const totalSpent = expenses.reduce((s, ex) => s + Number(ex.amount), 0);
    const paidAmount = expenses.filter(ex => ex.paid).reduce((s, ex) => s + Number(ex.amount), 0);

    overviewEl.classList.remove('hidden');
    document.getElementById('budget-spent').textContent = formatCurrency(paidAmount);
    document.getElementById('budget-total-display').textContent = formatCurrency(totalSpent);

    const pct = totalSpent > 0 ? Math.min((paidAmount / totalSpent) * 100, 100) : 0;
    const bar = document.getElementById('budget-bar');
    bar.style.width = pct + '%';
    bar.className = 'budget-bar' + (pct > 80 ? ' over-budget' : '');

    if (expenses.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No expenses tracked yet. Click "+ Add Expense" to start.</p>';
      return;
    }

    listEl.innerHTML = expenses.map(ex => `
      <div class="card expense-card ${ex.paid ? 'paid' : ''}">
        <div class="card-header">
          <h4>${escapeHtml(ex.description)}</h4>
          <span class="expense-amount">${formatCurrency(ex.amount)}</span>
        </div>
        <div class="card-body">
          <span class="expense-category">${categoryLabels[ex.category] || ex.category}</span>
          <span class="expense-status ${ex.paid ? 'paid' : 'unpaid'}">${ex.paid ? 'Paid' : 'Unpaid'}</span>
        </div>
        <div class="card-actions">
          <button class="btn btn-sm btn-secondary" onclick="app.editExpense('${ex.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="app.deleteExpense('${ex.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  }

  addExpenseBtn.addEventListener('click', () => {
    document.getElementById('expense-form').reset();
    document.getElementById('expense-id').value = '';
    document.getElementById('expense-event-id').value = budgetEventFilter.value;
    document.getElementById('expense-modal-title').textContent = 'Add Expense';
    openModal('expense-modal');
  });

  document.getElementById('expense-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('expense-id').value;
    const expenseData = {
      eventId: document.getElementById('expense-event-id').value,
      category: document.getElementById('expense-category').value,
      description: document.getElementById('expense-description').value.trim(),
      amount: parseFloat(document.getElementById('expense-amount').value),
      paid: document.getElementById('expense-paid').checked,
    };

    if (id) {
      const idx = data.expenses.findIndex(ex => ex.id === id);
      if (idx !== -1) data.expenses[idx] = { ...data.expenses[idx], ...expenseData };
    } else {
      data.expenses.push({ id: generateId(), ...expenseData });
    }

    saveData(data);
    closeModal('expense-modal');
    renderAll();
  });

  function editExpense(id) {
    const ex = data.expenses.find(e => e.id === id);
    if (!ex) return;
    document.getElementById('expense-id').value = ex.id;
    document.getElementById('expense-event-id').value = ex.eventId;
    document.getElementById('expense-category').value = ex.category;
    document.getElementById('expense-description').value = ex.description;
    document.getElementById('expense-amount').value = ex.amount;
    document.getElementById('expense-paid').checked = ex.paid;
    document.getElementById('expense-modal-title').textContent = 'Edit Expense';
    openModal('expense-modal');
  }

  function deleteExpense(id) {
    if (!confirm('Delete this expense?')) return;
    data.expenses = data.expenses.filter(ex => ex.id !== id);
    saveData(data);
    renderAll();
  }

  // ── Tasks CRUD ──

  const taskEventFilter = document.getElementById('task-event-filter');
  const addTaskBtn = document.getElementById('add-task-btn');

  taskEventFilter.addEventListener('change', () => {
    addTaskBtn.disabled = !taskEventFilter.value;
    renderTasks();
  });

  function renderTasks() {
    const eventId = taskEventFilter.value;
    const listEl = document.getElementById('tasks-list');

    if (!eventId) {
      listEl.innerHTML = '<p class="empty-state">Select an event to manage its tasks.</p>';
      return;
    }

    const tasks = data.tasks
      .filter(t => t.eventId === eventId)
      .sort((a, b) => {
        const priorityOrder = { high: 0, medium: 1, low: 2 };
        if (a.completed !== b.completed) return a.completed ? 1 : -1;
        return (priorityOrder[a.priority] || 1) - (priorityOrder[b.priority] || 1);
      });

    if (tasks.length === 0) {
      listEl.innerHTML = '<p class="empty-state">No tasks yet. Click "+ Add Task" to start planning.</p>';
      return;
    }

    listEl.innerHTML = tasks.map(t => `
      <div class="task-item ${t.completed ? 'completed' : ''} priority-${t.priority}">
        <div class="task-check">
          <input type="checkbox" ${t.completed ? 'checked' : ''} onchange="app.toggleTask('${t.id}')">
        </div>
        <div class="task-info">
          <span class="task-title">${escapeHtml(t.title)}</span>
          <div class="task-meta">
            <span class="priority-badge priority-${t.priority}">${t.priority}</span>
            ${t.due ? `<span class="task-due">Due: ${formatDate(t.due)}</span>` : ''}
          </div>
        </div>
        <div class="task-actions">
          <button class="btn btn-sm btn-secondary" onclick="app.editTask('${t.id}')">Edit</button>
          <button class="btn btn-sm btn-danger" onclick="app.deleteTask('${t.id}')">Delete</button>
        </div>
      </div>
    `).join('');
  }

  addTaskBtn.addEventListener('click', () => {
    document.getElementById('task-form').reset();
    document.getElementById('task-id').value = '';
    document.getElementById('task-event-id').value = taskEventFilter.value;
    document.getElementById('task-modal-title').textContent = 'Add Task';
    openModal('task-modal');
  });

  document.getElementById('task-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const id = document.getElementById('task-id').value;
    const taskData = {
      eventId: document.getElementById('task-event-id').value,
      title: document.getElementById('task-title').value.trim(),
      due: document.getElementById('task-due').value,
      priority: document.getElementById('task-priority').value,
    };

    if (id) {
      const idx = data.tasks.findIndex(t => t.id === id);
      if (idx !== -1) data.tasks[idx] = { ...data.tasks[idx], ...taskData };
    } else {
      data.tasks.push({ id: generateId(), completed: false, ...taskData });
    }

    saveData(data);
    closeModal('task-modal');
    renderAll();
  });

  function editTask(id) {
    const t = data.tasks.find(t => t.id === id);
    if (!t) return;
    document.getElementById('task-id').value = t.id;
    document.getElementById('task-event-id').value = t.eventId;
    document.getElementById('task-title').value = t.title;
    document.getElementById('task-due').value = t.due || '';
    document.getElementById('task-priority').value = t.priority;
    document.getElementById('task-modal-title').textContent = 'Edit Task';
    openModal('task-modal');
  }

  function toggleTask(id) {
    const t = data.tasks.find(t => t.id === id);
    if (t) {
      t.completed = !t.completed;
      saveData(data);
      renderAll();
    }
  }

  function deleteTask(id) {
    if (!confirm('Delete this task?')) return;
    data.tasks = data.tasks.filter(t => t.id !== id);
    saveData(data);
    renderAll();
  }

  // ── Render All ──

  function renderAll() {
    populateEventFilters();
    renderDashboard();
    renderEvents();
    renderGuests();
    renderExpenses();
    renderTasks();
  }

  // ── Public API (for onclick handlers) ──

  window.app = {
    editEvent,
    deleteEvent,
    editGuest,
    deleteGuest,
    editExpense,
    deleteExpense,
    editTask,
    toggleTask,
    deleteTask,
  };

  // ── Init ──
  renderAll();
})();
