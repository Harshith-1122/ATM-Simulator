"use strict";

/* =====================================================================
   ATM SIMULATOR

   The code is split into three layers so it is easy to connect to a
   real database later:

     1. DataStore  - saves and loads data (today: the browser's
                     localStorage; later: calls to a backend / database)
     2. Bank       - all the ATM rules (PIN check, deposit, withdraw,
                     history). It never touches the page.
     3. initUI()   - reads what the user types, calls Bank, shows results.

   To use a database, only DataStore (and the Bank methods that call it)
   need to change. See README.md for the suggested API and tables.
   ===================================================================== */


/* ---------------------------------------------------------------------
   0. SETTINGS - change these to adjust the ATM's behaviour
   --------------------------------------------------------------------- */
const CONFIG = {
  currency: "USD",          // any currency code, e.g. "EUR", "GBP"
  locale: "en-US",          // controls number and date formatting
  accountLength: 6,
  pinLength: 4,
  maxPinAttempts: 3,        // wrong PINs allowed before the account locks
  lockSeconds: 60,          // how long a locked account stays locked
  maxDeposit: 10000,        // per transaction (in whole currency units)
  maxWithdrawal: 1000,      // per transaction
  withdrawStep: 10,         // withdrawals must be a multiple of this
  idleSeconds: 60,          // automatic logout after this much inactivity
  storageKey: "atm-simulator-data-v1",
};


/* ---------------------------------------------------------------------
   Helpers
   Money is stored as whole cents (integers) so 0.1 + 0.2 style rounding
   errors can never happen.
   --------------------------------------------------------------------- */
class BankError extends Error {}   // errors that are safe to show the user

const moneyFormatter = new Intl.NumberFormat(CONFIG.locale, {
  style: "currency",
  currency: CONFIG.currency,
});

function formatMoney(cents) {
  return moneyFormatter.format(cents / 100);
}

function formatDate(isoString) {
  return new Date(isoString).toLocaleString(CONFIG.locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

// Turns text like "50" or "1,250.75" into cents, or throws a BankError.
function parseAmount(text) {
  const cleaned = String(text).trim().replace(/,/g, "");
  if (cleaned === "") {
    throw new BankError("Enter an amount.");
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new BankError("Enter a valid amount using numbers only, for example 50 or 50.25.");
  }
  const cents = Math.round(parseFloat(cleaned) * 100);
  if (cents <= 0) {
    throw new BankError("The amount must be greater than zero.");
  }
  return cents;
}

function validatePin(pin, label) {
  const pattern = new RegExp("^\\d{" + CONFIG.pinLength + "}$");
  if (!pattern.test(pin)) {
    throw new BankError(label + " must be exactly " + CONFIG.pinLength + " digits.");
  }
}

// A simple scrambling function so PINs are not saved as plain text.
// LEARNING ONLY: a real bank hashes PINs on the server with bcrypt or argon2.
function hashPin(accountNumber, pin) {
  const text = accountNumber + ":" + pin + ":atm-salt";
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash << 5) + hash + text.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16);
}


/* ---------------------------------------------------------------------
   1. DataStore - the only place that knows WHERE data is saved
   --------------------------------------------------------------------- */
const DataStore = {
  load() {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error("Could not read saved data:", err);
      return null;
    }
  },

  save(data) {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(data));
    } catch (err) {
      console.error("Could not save data:", err);
    }
  },

  clear() {
    try {
      localStorage.removeItem(CONFIG.storageKey);
    } catch (err) {
      console.error("Could not clear data:", err);
    }
  },
};


/* ---------------------------------------------------------------------
   Account and transaction builders (used by Bank and the demo data)
   --------------------------------------------------------------------- */
function makeAccount(accountNumber, name, pin) {
  return {
    accountNumber: accountNumber,
    name: name,
    pinHash: hashPin(accountNumber, pin),
    balance: 0,               // cents
    failedAttempts: 0,
    lockedUntil: null,        // timestamp in ms, or null
    transactions: [],
  };
}

// Adds a transaction AND updates the balance, so the two never disagree.
function addTransaction(account, type, cents, note, date) {
  account.balance += type === "withdrawal" ? -cents : cents;
  account.transactions.push({
    id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    type: type,               // "deposit" or "withdrawal"
    amount: cents,
    balanceAfter: account.balance,
    note: note,
    date: (date || new Date()).toISOString(),
  });
}

function daysAgo(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d;
}

function createSeedData() {
  const alex = makeAccount("100001", "Alex Carter", "1234");
  addTransaction(alex, "deposit", 100000, "Opening deposit", daysAgo(30));
  addTransaction(alex, "withdrawal", 20000, "ATM withdrawal", daysAgo(21));
  addTransaction(alex, "deposit", 45000, "Cash deposit", daysAgo(12));
  addTransaction(alex, "withdrawal", 6000, "ATM withdrawal", daysAgo(4));

  const sam = makeAccount("100002", "Sam Rivera", "4321");
  addTransaction(sam, "deposit", 30000, "Opening deposit", daysAgo(15));
  addTransaction(sam, "withdrawal", 5000, "ATM withdrawal", daysAgo(2));

  return { accounts: { "100001": alex, "100002": sam } };
}


/* ---------------------------------------------------------------------
   2. Bank - the ATM rules. No page code in here.
   --------------------------------------------------------------------- */
const Bank = {
  data: null,

  init() {
    this.data = DataStore.load();
    if (!this.data || !this.data.accounts) {
      this.data = createSeedData();
      this.save();
    }
  },

  save() {
    DataStore.save(this.data);
  },

  reset() {
    DataStore.clear();
    this.data = createSeedData();
    this.save();
  },

  requireAccount(accountNumber) {
    const account = this.data.accounts[accountNumber];
    if (!account) {
      throw new BankError("Account not found. Please log in again.");
    }
    return account;
  },

  /* ----- Authentication ----- */
  login(accountNumber, pin) {
    const accountPattern = new RegExp("^\\d{" + CONFIG.accountLength + "}$");
    if (!accountPattern.test(accountNumber)) {
      throw new BankError("Enter your " + CONFIG.accountLength + "-digit account number.");
    }
    validatePin(pin, "Your PIN");

    const account = this.data.accounts[accountNumber];
    if (!account) {
      throw new BankError("Account not found. Check the number or open a new account.");
    }

    // Locked after too many wrong PINs?
    if (account.lockedUntil && Date.now() < account.lockedUntil) {
      const seconds = Math.ceil((account.lockedUntil - Date.now()) / 1000);
      throw new BankError("This account is locked. Try again in " + seconds + " seconds.");
    }

    if (account.pinHash !== hashPin(accountNumber, pin)) {
      account.failedAttempts += 1;
      if (account.failedAttempts >= CONFIG.maxPinAttempts) {
        account.failedAttempts = 0;
        account.lockedUntil = Date.now() + CONFIG.lockSeconds * 1000;
        this.save();
        throw new BankError(
          "Too many wrong PINs. The account is locked for " + CONFIG.lockSeconds + " seconds."
        );
      }
      const left = CONFIG.maxPinAttempts - account.failedAttempts;
      this.save();
      throw new BankError("Wrong PIN. " + left + (left === 1 ? " attempt" : " attempts") + " left.");
    }

    account.failedAttempts = 0;
    account.lockedUntil = null;
    this.save();
    return account.accountNumber;
  },

  register(name, pin, pinConfirm, depositText) {
    name = name.trim();
    if (name.length < 2) {
      throw new BankError("Enter your full name.");
    }
    validatePin(pin, "The PIN");
    if (pin !== pinConfirm) {
      throw new BankError("The two PINs do not match.");
    }

    let openingCents = 0;
    if (depositText.trim() !== "") {
      openingCents = parseAmount(depositText);
      if (openingCents > CONFIG.maxDeposit * 100) {
        throw new BankError("The opening deposit cannot be more than " + formatMoney(CONFIG.maxDeposit * 100) + ".");
      }
    }

    const numbers = Object.keys(this.data.accounts).map(Number);
    const accountNumber = String(Math.max(100000, ...numbers) + 1);
    const account = makeAccount(accountNumber, name, pin);
    if (openingCents > 0) {
      addTransaction(account, "deposit", openingCents, "Opening deposit");
    }
    this.data.accounts[accountNumber] = account;
    this.save();
    return accountNumber;
  },

  changePin(accountNumber, currentPin, newPin, newPinConfirm) {
    const account = this.requireAccount(accountNumber);
    validatePin(currentPin, "Your current PIN");
    if (account.pinHash !== hashPin(accountNumber, currentPin)) {
      throw new BankError("Your current PIN is wrong.");
    }
    validatePin(newPin, "The new PIN");
    if (newPin === currentPin) {
      throw new BankError("The new PIN must be different from the current one.");
    }
    if (newPin !== newPinConfirm) {
      throw new BankError("The new PINs do not match.");
    }
    account.pinHash = hashPin(accountNumber, newPin);
    this.save();
  },

  /* ----- Money ----- */
  getName(accountNumber) {
    return this.requireAccount(accountNumber).name;
  },

  getBalance(accountNumber) {
    return this.requireAccount(accountNumber).balance;
  },

  deposit(accountNumber, amountText) {
    const account = this.requireAccount(accountNumber);
    const cents = parseAmount(amountText);
    if (cents > CONFIG.maxDeposit * 100) {
      throw new BankError("The most you can deposit at once is " + formatMoney(CONFIG.maxDeposit * 100) + ".");
    }
    addTransaction(account, "deposit", cents, "Cash deposit");
    this.save();
    return { amount: cents, balance: account.balance };
  },

  withdraw(accountNumber, amountText) {
    const account = this.requireAccount(accountNumber);
    const cents = parseAmount(amountText);

    if (cents % (CONFIG.withdrawStep * 100) !== 0) {
      throw new BankError("Withdrawals must be in multiples of " + formatMoney(CONFIG.withdrawStep * 100) + ".");
    }
    if (cents > CONFIG.maxWithdrawal * 100) {
      throw new BankError("The most you can withdraw at once is " + formatMoney(CONFIG.maxWithdrawal * 100) + ".");
    }
    if (cents > account.balance) {
      throw new BankError("Insufficient funds. Your balance is " + formatMoney(account.balance) + ".");
    }

    addTransaction(account, "withdrawal", cents, "ATM withdrawal");
    this.save();
    return { amount: cents, balance: account.balance };
  },

  /* ----- History (newest first), with optional filtering ----- */
  getHistory(accountNumber, options) {
    const account = this.requireAccount(accountNumber);
    const type = (options && options.type) || "all";
    const search = ((options && options.search) || "").trim().toLowerCase();

    return account.transactions
      .filter(function (t) {
        const typeMatches = type === "all" || t.type === type;
        const searchMatches =
          search === "" ||
          t.note.toLowerCase().includes(search) ||
          (t.amount / 100).toFixed(2).includes(search);
        return typeMatches && searchMatches;
      })
      .reverse();
  },
};


/* ---------------------------------------------------------------------
   3. UI - connects the page to Bank
   --------------------------------------------------------------------- */
function initUI() {
  Bank.init();

  const $ = function (id) { return document.getElementById(id); };
  const PROTECTED_VIEWS = ["menu", "balance", "deposit", "withdraw", "history", "pin"];

  let currentAccount = null;   // account number of the logged-in user
  let historyFilter = "all";
  let idleTimer = null;

  /* ----- Messages ----- */
  function showMessage(text, type) {
    const box = $("message");
    box.textContent = text;
    box.className = "message " + (type || "error");
    box.hidden = false;
  }

  function clearMessage() {
    $("message").hidden = true;
  }

  function handleError(err) {
    if (err instanceof BankError) {
      showMessage(err.message, "error");
    } else {
      console.error(err);
      showMessage("Something went wrong. Please try again.", "error");
    }
  }

  /* ----- Screens ----- */
  function showView(name) {
    document.querySelectorAll(".view").forEach(function (view) {
      view.hidden = view.id !== "view-" + name;
    });
    clearMessage();
    const firstInput = $("view-" + name).querySelector("input");
    if (firstInput) firstInput.focus();
  }

  function navigate(name) {
    if (PROTECTED_VIEWS.includes(name) && !currentAccount) {
      showView("login");
      return;
    }
    // Start forms empty each time the user opens them
    if (["deposit", "withdraw", "pin", "register"].includes(name)) {
      $("view-" + name).querySelector("form").reset();
    }
    if (name === "menu") renderMenu();
    if (name === "balance") renderBalance();
    if (name === "withdraw") renderWithdrawRules();
    if (name === "history") renderHistory();
    showView(name);
  }

  function renderMenu() {
    $("menu-greeting").textContent =
      "Hello, " + Bank.getName(currentAccount) + ". What would you like to do?";
  }

  function renderBalance() {
    $("balance-account").textContent = "Account ending " + currentAccount.slice(-4);
    $("balance-amount").textContent = formatMoney(Bank.getBalance(currentAccount));
  }

  function renderWithdrawRules() {
    $("withdraw-rules").textContent =
      "Multiples of " + formatMoney(CONFIG.withdrawStep * 100) +
      ", up to " + formatMoney(CONFIG.maxWithdrawal * 100) + " at a time.";
  }

  // Builds the history table. textContent is used (not innerHTML) so
  // anything a user typed can never be run as code.
  function renderHistory() {
    const list = Bank.getHistory(currentAccount, {
      type: historyFilter,
      search: $("history-search").value,
    });

    const body = $("history-body");
    body.innerHTML = "";
    let totalIn = 0;
    let totalOut = 0;

    list.forEach(function (t) {
      const isIn = t.type === "deposit";
      if (isIn) totalIn += t.amount; else totalOut += t.amount;

      const row = document.createElement("tr");
      addCell(row, formatDate(t.date));
      addCell(row, t.note);
      addCell(row, (isIn ? "+" : "\u2212") + formatMoney(t.amount), "num " + (isIn ? "in" : "out"));
      addCell(row, formatMoney(t.balanceAfter), "num");
      body.appendChild(row);
    });

    $("total-in").textContent = formatMoney(totalIn);
    $("total-out").textContent = formatMoney(totalOut);
    $("history-empty").hidden = list.length > 0;
  }

  function addCell(row, text, className) {
    const cell = document.createElement("td");
    cell.textContent = text;
    if (className) cell.className = className;
    row.appendChild(cell);
  }

  function updateFilterButtons() {
    document.querySelectorAll("[data-filter]").forEach(function (btn) {
      btn.setAttribute("aria-pressed", String(btn.dataset.filter === historyFilter));
    });
  }

  /* ----- Logout and inactivity ----- */
  function logout(reason) {
    currentAccount = null;
    clearTimeout(idleTimer);
    document.querySelectorAll("form").forEach(function (form) { form.reset(); });
    $("history-search").value = "";
    historyFilter = "all";
    updateFilterButtons();
    showView("login");
    showMessage(reason || "You have been logged out. Thank you for banking with us.", "info");
  }

  function resetIdleTimer() {
    clearTimeout(idleTimer);
    if (!currentAccount) return;
    idleTimer = setTimeout(function () {
      logout("You were logged out after " + CONFIG.idleSeconds + " seconds of inactivity.");
    }, CONFIG.idleSeconds * 1000);
  }

  ["click", "keydown", "input"].forEach(function (eventName) {
    document.addEventListener(eventName, resetIdleTimer);
  });

  /* ----- Buttons that navigate, and quick-amount chips ----- */
  document.addEventListener("click", function (e) {
    const goto = e.target.closest("[data-goto]");
    if (goto) {
      navigate(goto.dataset.goto);
      return;
    }
    const chip = e.target.closest("[data-amount]");
    if (chip) {
      chip.closest("form").querySelector(".amount-input").value = chip.dataset.amount;
    }
  });

  // Only allow digits in PIN and account fields
  document.querySelectorAll(".digits-only").forEach(function (input) {
    input.addEventListener("input", function () {
      input.value = input.value.replace(/\D/g, "");
    });
  });

  /* ----- On-screen PIN keypad ----- */
  document.querySelector(".keypad").addEventListener("click", function (e) {
    const key = e.target.closest("[data-key]");
    if (!key) return;
    const pinInput = $("login-pin");
    if (key.dataset.key === "clear") {
      pinInput.value = "";
    } else if (key.dataset.key === "back") {
      pinInput.value = pinInput.value.slice(0, -1);
    } else if (pinInput.value.length < CONFIG.pinLength) {
      pinInput.value += key.dataset.key;
    }
  });

  /* ----- Forms ----- */
  $("login-form").addEventListener("submit", function (e) {
    e.preventDefault();
    try {
      currentAccount = Bank.login($("login-account").value.trim(), $("login-pin").value);
      $("login-pin").value = "";
      resetIdleTimer();
      navigate("menu");
    } catch (err) {
      $("login-pin").value = "";
      handleError(err);
      $("login-pin").focus();
    }
  });

  $("register-form").addEventListener("submit", function (e) {
    e.preventDefault();
    try {
      const number = Bank.register(
        $("register-name").value,
        $("register-pin").value,
        $("register-pin2").value,
        $("register-deposit").value
      );
      navigate("login");
      $("login-account").value = number;
      $("login-pin").focus();
      showMessage(
        "Account created. Your account number is " + number + ". Keep it safe, you need it to log in.",
        "success"
      );
    } catch (err) {
      handleError(err);
    }
  });

  $("deposit-form").addEventListener("submit", function (e) {
    e.preventDefault();
    try {
      const result = Bank.deposit(currentAccount, $("deposit-amount").value);
      navigate("balance");
      showMessage(
        "Deposited " + formatMoney(result.amount) + ". Your new balance is " + formatMoney(result.balance) + ".",
        "success"
      );
    } catch (err) {
      handleError(err);
    }
  });

  $("withdraw-form").addEventListener("submit", function (e) {
    e.preventDefault();
    try {
      const result = Bank.withdraw(currentAccount, $("withdraw-amount").value);
      navigate("balance");
      showMessage(
        "Please take your cash: " + formatMoney(result.amount) + ". Your new balance is " + formatMoney(result.balance) + ".",
        "success"
      );
    } catch (err) {
      handleError(err);
    }
  });

  $("pin-form").addEventListener("submit", function (e) {
    e.preventDefault();
    try {
      Bank.changePin(
        currentAccount,
        $("pin-current").value,
        $("pin-new").value,
        $("pin-new2").value
      );
      navigate("menu");
      showMessage("Your PIN has been changed.", "success");
    } catch (err) {
      handleError(err);
    }
  });

  /* ----- History filters and search ----- */
  document.querySelectorAll("[data-filter]").forEach(function (btn) {
    btn.addEventListener("click", function () {
      historyFilter = btn.dataset.filter;
      updateFilterButtons();
      renderHistory();
    });
  });
  $("history-search").addEventListener("input", renderHistory);

  /* ----- Logout and demo reset ----- */
  $("logout-btn").addEventListener("click", function () { logout(); });

  // Two clicks are needed, so accounts are not deleted by accident
  let resetArmed = false;
  $("reset-demo").addEventListener("click", function () {
    const button = $("reset-demo");
    if (!resetArmed) {
      resetArmed = true;
      button.textContent = "Click again to confirm";
      setTimeout(function () {
        resetArmed = false;
        button.textContent = "Reset demo data";
      }, 4000);
      return;
    }
    resetArmed = false;
    button.textContent = "Reset demo data";
    Bank.reset();
    showMessage("Demo data restored. Accounts you created were removed.", "info");
  });

  showView("login");
}

document.addEventListener("DOMContentLoaded", initUI);
