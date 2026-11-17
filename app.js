'use strict';

const $ = id => document.getElementById(id);
const money = (n, decimals = 2) => new Intl.NumberFormat('en-US', {
  style: 'currency', currency: 'USD', minimumFractionDigits: decimals, maximumFractionDigits: decimals
}).format(n);
const integer = n => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(n);
const number = value => Number(String(value).replace(/[$,%\s,]/g, ''));
const ids = ['price', 'down', 'rate', 'years', 'escrow', 'start'];
const adjustments = new Map();
let currentMonth = null;
let currentSchedule = null;
let newPaymentEdited = false;

// Local persistence — IndexedDB
const DB_NAME = 'Amortization';
const DB_VERSION = 1;
const STORE_NAME = 'settings';

let db = null;
let restoringData = true;

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readSavedData() {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get('currentLoan');

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function saveData() {
  if (restoringData || !db) return;

  const data = {
    inputs: Object.fromEntries(
      ids.map(id => [id, $(id).value])
    ),
    adjustments: Array.from(adjustments.entries())
  };

  const transaction = db.transaction(STORE_NAME, 'readwrite');
  transaction.objectStore(STORE_NAME).put(data, 'currentLoan');

  transaction.onerror = () => {
    console.error('Unable to save loan data:', transaction.error);
  };
}

async function initializeDatabase() {
  try {
    db = await openDatabase();

    const saved = await readSavedData();

    if (saved) {
      for (const id of ids) {
        if (Object.hasOwn(saved.inputs || {}, id)) {
          $(id).value = saved.inputs[id];
        }
      }

      adjustments.clear();

      for (const [month, change] of saved.adjustments || []) {
        adjustments.set(Number(month), change);
      }
    }
  } catch (error) {
    console.error('Unable to initialize local storage:', error);
  } finally {
    restoringData = false;
    update();
  }
}

function formatCurrencyField(el) {
  const raw = el.value.trim();
  if (!raw) return;

  // Convert a percentage down payment to a dollar amount.
  if (el.id === 'down' && raw.includes('%')) {
    const price = number($('price').value);
    const percent = number(raw);

    if (Number.isFinite(price) && price > 0 &&
        Number.isFinite(percent) && percent >= 0) {
      el.value = money(price * percent / 100, 0);
    }
    return;
  }

  const n = number(raw);
  if (Number.isFinite(n)) {
    const decimals = raw.includes('.')
      ? Math.min((raw.split('.')[1] || '').replace(/[^0-9]/g, '').length, 2)
      : 0;

    el.value = money(n, decimals);
  }
}

function loanInputs() {
  const price = number($('price').value);
  const downRaw = $('down').value.trim();
  const down = downRaw.includes('%') ? price * number(downRaw) / 100 : number(downRaw);
  const rate = number($('rate').value);
  const years = number($('years').value);
  const escrow = number($('escrow').value);
  const principal = price - down;
  const error = (!Number.isFinite(price) || price <= 0) ? 'Enter a valid house price, down payment and annual interest rate.'
    : (!Number.isFinite(down) || down < 0 || down >= price) ? 'Down payment must be at least zero and less than the house price.'
    : (!Number.isFinite(rate) || rate < 0 || rate > 100) ? 'Enter an annual interest rate between 0% and 100%.'
    : (!Number.isInteger(years) || years < 1 || years > 40) ? 'Loan term must be a whole number from 1 to 40 years.'
    : (!Number.isFinite(escrow) || escrow < 0) ? 'Escrow must be zero or greater.' : '';
  return { principal, rate, months: years * 12, escrow, error };
}

function calculateSchedule(principal, annualRate, months, changes = new Map(), escrow = 0) {
  const r = annualRate / 1200;
  const regularPayment = r === 0 ? principal / months : principal * r / (1 - Math.pow(1 + r, -months));
  let payment = regularPayment;
  let balance = principal;
  let totalPrincipal = 0;
  let totalInterest = 0;
  let totalPaid = 0;
  let totalEscrow = 0;
  const rows = [];

  for (let m = 1; m <= months && balance > 0.0000001; m++) {
    const interest = balance * r;
    // A regular payment must cover the interest and may not exceed the remaining payoff.
    const actualPayment = Math.min(payment, balance + interest);
    const principalPaid = actualPayment - interest;
    balance = Math.max(0, balance - principalPaid);
    totalPrincipal += principalPaid;
    totalInterest += interest;
    totalPaid += actualPayment + escrow;
    totalEscrow += escrow;

    const balanceBeforeExtra = balance;
    const totalPrincipalBeforeExtra = totalPrincipal;
    const totalPaidBeforeExtra = totalPaid;
    const change = changes.get(m);
    let extra = 0;
    if (change && change.extra > 0 && balance > 0) {
      extra = Math.min(change.extra, balance);
      balance = Math.max(0, balance - extra);
      totalPrincipal += extra;
      totalPaid += extra;
    }
    // The new payment includes escrow and begins with the NEXT regular payment.
    if (change && change.newPayment != null) payment = change.newPayment - escrow;
    rows.push({
      m, principalPaid, interest, escrow,
      monthlyPayment: actualPayment + escrow,
      totalPrincipal: totalPrincipalBeforeExtra,
      totalInterest,
      totalPaid: totalPaidBeforeExtra,
      balance: balanceBeforeExtra,
      balanceBeforeExtra,
      extra,
      totalPrincipalAfterExtra: totalPrincipal,
      totalPaidAfterExtra: totalPaid,
      balanceAfterExtra: balance,
      change: change ? { ...change } : null
    });
  }
  return { payment: regularPayment, rows, totalInterest, totalEscrow, totalPaid, balance };
}

function payoffLabel(months, start) {
  const duration = `${Math.floor(months / 12)} years ${months % 12} months`;
  if (!start || !months) return duration;
  const [y, m] = start.split('-').map(Number);
  if (!y || !m) return duration;
  const dateText = new Date(y, m - 1 + months - 1, 1).toLocaleDateString('en-US', {
    month: 'short', year: 'numeric'
  });
  return `${duration} - ${dateText}`;
}

function durationLabel(months) {
  return `${Math.floor(months / 12)} yr ${months % 12} mo`;
}

function update() {
  const { principal, rate, months, escrow, error } = loanInputs();
  $('error').hidden = !error;
  $('error').textContent = error;
  $('loan').textContent = Number.isFinite(principal) && principal > 0 ? money(principal, 0) : '—';
  $('summaryLoan').textContent = Number.isFinite(principal) && principal > 0 ? money(principal, 0) : '—';
  $('originalLoan').textContent = $('summaryLoan').textContent;
  const hasEscrow = Number.isFinite(escrow) && escrow > 0;
  document.querySelectorAll('.summary, .savings').forEach(el => el.classList.toggle('with-escrow', hasEscrow));
  document.querySelectorAll('.escrow-sign, .escrow-metric, .escrow-saving, .escrow-column').forEach(el => { el.hidden = !hasEscrow; });
  document.querySelector('.table-wrap table').classList.toggle('with-escrow', hasEscrow);
  if (error) {
    ['originalEscrow', 'currentEscrow', 'escrowSaved', 'pi', 'total', 'interest', 'payments', 'payoff', 'interestSaved', 'paymentSaved', 'timeSaved', 'originalInterest', 'originalPayments', 'originalPayoff'].forEach(id => $(id).textContent = '—');
    $('rows').replaceChildren();
    currentSchedule = null;
    return;
  }

  const baseline = calculateSchedule(principal, rate, months, new Map(), escrow);
  const result = calculateSchedule(principal, rate, months, adjustments, escrow);
  currentSchedule = result;
  $('originalEscrow').textContent = money(baseline.totalEscrow, 0);
  $('currentEscrow').textContent = money(result.totalEscrow, 0);
  $('escrowSaved').textContent = money(baseline.totalEscrow - result.totalEscrow, 0);
  $('originalInterest').textContent = money(baseline.totalInterest, 0);
  $('originalPayments').textContent = money(baseline.totalPaid, 0);
  $('originalPayoff').textContent = payoffLabel(baseline.rows.length, $('start').value);
  $('pi').textContent = money(baseline.payment);
  $('total').textContent = money(baseline.payment + escrow);
  $('interest').textContent = money(result.totalInterest, 0);
  $('payments').textContent = money(result.totalPaid, 0);
  $('payoff').textContent = payoffLabel(result.rows.length, $('start').value);
  $('interestSaved').textContent = money(baseline.totalInterest - result.totalInterest, 0);
  $('paymentSaved').textContent = money(baseline.totalPaid - result.totalPaid, 0);
  $('timeSaved').textContent = durationLabel(baseline.rows.length - result.rows.length);


  const fragment = document.createDocumentFragment();
  for (const row of result.rows) {
    const tr = document.createElement('tr');
    tr.className = (row.m - 1) % 12 === 0 ? 'year-start' : '';
    tr.tabIndex = 0;
    tr.setAttribute('aria-label', `Edit What If adjustments after month ${row.m}`);
    tr.title = `Edit What If adjustments after month ${row.m}`;
    tr.addEventListener('click', () => openEditor(row.m));
    tr.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEditor(row.m); }
    });
const values = [
  (row.m - 1) % 12 === 0
    ? `y${Math.floor((row.m - 1) / 12) + 1} ${row.m}`
    : row.m,
  money(row.principalPaid, 0), money(row.interest, 0),
      ...(hasEscrow ? [money(row.escrow, 0)] : []), money(row.monthlyPayment, 0),
      money(row.totalPrincipal, 0), money(row.totalInterest, 0), money(row.totalPaid, 0), money(row.balanceBeforeExtra, 0)];
    values.forEach(value => {
      const td = document.createElement('td');
      td.textContent = value;
      tr.append(td);
    });
    fragment.append(tr);
    if (row.extra > 0) {
      const extraRow = document.createElement('tr');
      extraRow.className = 'extra-row';
      extraRow.tabIndex = 0;
      extraRow.addEventListener('click', () => openEditor(row.m));
      extraRow.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          openEditor(row.m);
        }
      });

      const values = [
        `Extra principal payment: ${money(row.extra, 0)}`,
        '',
        '',
        ...(hasEscrow ? [''] : []),
        '',
        money(row.totalPrincipalAfterExtra, 0),
        '',
        money(row.totalPaidAfterExtra, 0),
        money(row.balanceAfterExtra, 0)
      ];

      values.forEach((value, index) => {
        const td = document.createElement('td');
        td.textContent = value;

        if (index === 0) {
          td.style.textAlign = 'left';
          td.style.overflow = 'visible';
        }

        extraRow.append(td);
      });

      fragment.append(extraRow);
    }
    if (row.change && row.change.newPayment != null) {
      const paymentRow = document.createElement('tr');
      paymentRow.className = 'extra-row';
      paymentRow.tabIndex = 0;
      paymentRow.addEventListener('click', () => openEditor(row.m));
      paymentRow.addEventListener('keydown', event => {
        if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openEditor(row.m); }
      });
      const td = document.createElement('td');
      td.colSpan = hasEscrow ? 9 : 8;
      td.textContent = `New monthly payment starting month ${row.m + 1}: ${money(row.change.newPayment)}${hasEscrow ? ' (including escrow)' : ''}`;
      paymentRow.append(td);
      fragment.append(paymentRow);
    }
  }
  $('rows').replaceChildren(fragment);
  $('scheduleHint').textContent = `${result.rows.length} monthly payments · Select a month to make a What If adjustment`;
}

function openEditor(month) {
  currentMonth = month;
  const change = adjustments.get(month) || {};
  const { principal, rate, months, escrow } = loanInputs();
  const baseline = calculateSchedule(principal, rate, months);
  const minimumPayment = baseline.payment + escrow;

  $('editorTitle').textContent = `What If · Month ${month}`;
  $('editorDescription').textContent = `Changes apply after the regular payment for month ${month}. A new monthly payment starts in month ${month + 1}.`;
  $('extraPayment').value = change.extra > 0 ? change.extra : '';
  $('newPayment').value = change.newPayment != null ? Math.round(change.newPayment) : '';
  $('newPaymentLabel').textContent = `New monthly payment${escrow > 0 ? ' (including escrow)' : ''}`;
  $('minimumPayment').textContent = `Minimum allowed: ${money(minimumPayment)}${escrow > 0 ? ' (including escrow)' : ''}`;  
  $('editorError').hidden = true;
  $('deleteAdjustment').hidden = !adjustments.has(month);
  newPaymentEdited = false;
  $('editor').showModal();

  if (change.newPayment != null) {
    $('newPayment').focus();
  } else {
    $('extraPayment').focus();
  }
}

$('newPayment').addEventListener('input', () => {
  newPaymentEdited = true;
});

function closeEditor() {
  $('editor').close();
  currentMonth = null;
}

$('adjustmentForm').addEventListener('submit', event => {
  event.preventDefault();
  if (currentMonth == null) return;
  const extraText = $('extraPayment').value.trim();
  const paymentText = $('newPayment').value.trim();
  const extra = extraText ? number(extraText) : 0;
  const { principal, rate, months, escrow } = loanInputs();
  const baseline = calculateSchedule(principal, rate, months);
  const currentRow = currentSchedule?.rows.find(row => row.m === currentMonth);

  // Determine the monthly payment in effect at the selected month.
  let currentPayment = baseline.payment + escrow;

  for (const row of currentSchedule?.rows || []) {
    if (row.m >= currentMonth) break;

    if (row.change?.newPayment != null) {
      currentPayment = row.change.newPayment;
    }
  }

  // Interpret +100 as an increase of $100.
  let newPayment = paymentText ? number(paymentText) : null;

  if (paymentText.startsWith('+')) {
    const increaseText = paymentText.slice(1).trim();
    const increase = number(increaseText);

    newPayment = increaseText && Number.isFinite(increase) && increase > 0
      ? currentPayment + increase
      : NaN;
  }
  
  // Preserve the original full-precision payment if the user
  // has not edited the New monthly payment field.
  const savedPayment = adjustments.get(currentMonth)?.newPayment;

  if (!newPaymentEdited && savedPayment != null) {
    newPayment = savedPayment;
  }
  
  let error = '';
  if (!Number.isFinite(extra) || extra < 0) error = 'Extra principal payment must be zero or greater.';
  else if (newPayment != null && (!Number.isFinite(newPayment) || newPayment <= escrow)) error = 'New monthly payment must exceed the monthly escrow.';
  else if (newPayment != null && newPayment - escrow + 0.000001 < baseline.payment) error = `New monthly payment must be at least ${money(baseline.payment + escrow)} including escrow.`;
  else if (extra > 0 && currentRow && extra > currentRow.balance + (currentRow.extra || 0) + 0.005) error = 'Extra principal payment cannot exceed the balance after the regular payment.';
  else if (newPayment != null && currentMonth >= months) error = 'There is no following month for a new monthly payment.';
  if (error) {
    $('editorError').textContent = error;
    $('editorError').hidden = false;
    return;
  }
  if (extra === 0 && newPayment == null) adjustments.delete(currentMonth);
  else adjustments.set(currentMonth, { extra, newPayment });
  closeEditor();
  update();
  saveData();
});

$('cancelAdjustment').addEventListener('click', closeEditor);
$('deleteAdjustment').addEventListener('click', () => {
  if (currentMonth != null) adjustments.delete(currentMonth);
  closeEditor();
  update();
  saveData();
});
$('editor').addEventListener('click', event => { if (event.target === $('editor')) closeEditor(); });
$('editor').addEventListener('close', () => { currentMonth = null; });

for (const id of ids) {
  $(id).addEventListener('input', () => {
    // Loan parameters define a new baseline; clear old month-specific adjustments.
    if (id !== 'start' && id !== 'escrow') adjustments.clear();
    update();
    saveData();
  });
}

for (const id of ['price', 'down', 'escrow']) {
  $(id).addEventListener('blur', () => {
    formatCurrencyField($(id));
    update();
    saveData();
  });
  $(id).addEventListener('focus', () => {
    const el = $(id);
    if (el.id === 'down' && el.value.includes('%')) return;
    el.value = el.value.replace(/[$,]/g, '');
    el.select();
  });
}
/*
// Reset button
$('reset').addEventListener('click', () => {
  Object.entries({ price: '', down: '', rate: '', years: '30', escrow: '', start: '' })
    .forEach(([id, value]) => { $(id).value = value; });
  adjustments.clear();
  update();
});
*/

// Display welcome instructions only on first launch.
const welcomeOverlay = $('welcomeOverlay');

if (!localStorage.getItem('amortizationWelcomeScreen')) {
  welcomeOverlay.hidden = false;
}

$('welcomeDismiss').addEventListener('click', () => {
  welcomeOverlay.hidden = true;
  localStorage.setItem('amortizationWelcomeScreen', '1');
});

// Register service worker for offline operation.
function startServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js')
        .catch(error => {
          console.error('Service worker registration failed:', error);
        });
    });
  }
}

initializeDatabase();
startServiceWorker();