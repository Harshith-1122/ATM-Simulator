#!/usr/bin/env python3
"""
ATM Simulator Backend Server
Integrates MySQL with the ATM simulator web app via Flask & PyMySQL.
"""

import os
import re
import uuid
from datetime import datetime, timedelta
from flask import Flask, request, jsonify, send_from_directory
from flask_cors import CORS
import pymysql

# Load .env if present
env_path = os.path.join(os.path.dirname(__file__), ".env")
if os.path.exists(env_path):
    with open(env_path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())

# Configuration
DB_HOST = os.environ.get("DB_HOST", "localhost")
DB_PORT = int(os.environ.get("DB_PORT", 3306))
DB_USER = os.environ.get("DB_USER", "root")
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
DB_NAME = os.environ.get("DB_NAME", "atm_db")
PORT = int(os.environ.get("PORT", 5000))

CONFIG = {
    "accountLength": 6,
    "pinLength": 4,
    "maxPinAttempts": 3,
    "lockSeconds": 60,
    "maxDeposit": 10000,
    "maxWithdrawal": 1000,
    "withdrawStep": 10,
}

app = Flask(__name__, static_folder=".")
CORS(app)


def hash_pin(account_number: str, pin: str) -> str:
    """Deterministic hash matching the JS ATM implementation."""
    text = f"{account_number}:{pin}:atm-salt"
    h = 5381
    for char in text:
        h = (((h << 5) + h + ord(char)) & 0xFFFFFFFF)
    return format(h, "x")


def get_raw_connection(use_db=True):
    return pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME if use_db else None,
        charset="utf8mb4",
        cursorclass=pymysql.cursors.DictCursor,
        autocommit=False,
    )


def init_database():
    """Ensure atm_db database and required tables exist and seed demo data."""
    try:
        # Step 1: Create database if not exists
        conn_no_db = get_raw_connection(use_db=False)
        try:
            with conn_no_db.cursor() as cur:
                cur.execute(
                    f"CREATE DATABASE IF NOT EXISTS `{DB_NAME}` "
                    "CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
                )
            conn_no_db.commit()
        finally:
            conn_no_db.close()

        # Step 2: Create tables and demo data in atm_db
        conn = get_raw_connection(use_db=True)
        try:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS accounts (
                        id INT AUTO_INCREMENT PRIMARY KEY,
                        account_number CHAR(6) NOT NULL UNIQUE,
                        holder_name VARCHAR(40) NOT NULL,
                        pin_hash VARCHAR(255) NOT NULL,
                        balance_cents BIGINT NOT NULL DEFAULT 0,
                        failed_attempts INT NOT NULL DEFAULT 0,
                        locked_until DATETIME NULL,
                        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
                    """
                )

                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS transactions (
                        id VARCHAR(64) PRIMARY KEY,
                        account_id INT NOT NULL,
                        type ENUM('deposit', 'withdrawal') NOT NULL,
                        amount_cents BIGINT NOT NULL,
                        balance_after_cents BIGINT NOT NULL,
                        note VARCHAR(100),
                        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
                        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
                    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
                    """
                )

                # Check if accounts table is empty
                cur.execute("SELECT COUNT(*) AS total FROM accounts")
                row = cur.fetchone()
                if row["total"] == 0:
                    seed_demo_data(cur)

            conn.commit()
            print(f"[MySQL] Successfully connected to '{DB_NAME}' and verified tables.")
            return True, None
        finally:
            conn.close()
    except Exception as ex:
        print(f"[MySQL Warning] Could not initialize database '{DB_NAME}': {ex}")
        return False, str(ex)


def seed_demo_data(cur):
    """Seed initial demo accounts and history into MySQL."""
    # Account 100001: Alex Carter
    cur.execute(
        """
        INSERT INTO accounts (account_number, holder_name, pin_hash, balance_cents, failed_attempts, locked_until)
        VALUES (%s, %s, %s, %s, 0, NULL)
        """,
        ("100001", "Alex Carter", hash_pin("100001", "1234"), 119000),
    )
    alex_id = cur.lastrowid

    now = datetime.now()
    cur.executemany(
        """
        INSERT INTO transactions (id, account_id, type, amount_cents, balance_after_cents, note, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        [
            (str(uuid.uuid4()), alex_id, "deposit", 100000, 100000, "Opening deposit", now - timedelta(days=30)),
            (str(uuid.uuid4()), alex_id, "withdrawal", 20000, 80000, "ATM withdrawal", now - timedelta(days=21)),
            (str(uuid.uuid4()), alex_id, "deposit", 45000, 125000, "Cash deposit", now - timedelta(days=12)),
            (str(uuid.uuid4()), alex_id, "withdrawal", 6000, 119000, "ATM withdrawal", now - timedelta(days=4)),
        ],
    )

    # Account 100002: Sam Rivera
    cur.execute(
        """
        INSERT INTO accounts (account_number, holder_name, pin_hash, balance_cents, failed_attempts, locked_until)
        VALUES (%s, %s, %s, %s, 0, NULL)
        """,
        ("100002", "Sam Rivera", hash_pin("100002", "4321"), 25000),
    )
    sam_id = cur.lastrowid

    cur.executemany(
        """
        INSERT INTO transactions (id, account_id, type, amount_cents, balance_after_cents, note, created_at)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        """,
        [
            (str(uuid.uuid4()), sam_id, "deposit", 30000, 30000, "Opening deposit", now - timedelta(days=15)),
            (str(uuid.uuid4()), sam_id, "withdrawal", 5000, 25000, "ATM withdrawal", now - timedelta(days=2)),
        ],
    )


def parse_cents(text):
    cleaned = str(text).strip().replace(",", "")
    if not cleaned:
        raise ValueError("Enter an amount.")
    if not re.match(r"^\d+(\.\d{1,2})?$", cleaned):
        raise ValueError("Enter a valid amount using numbers only, for example 50 or 50.25.")
    cents = int(round(float(cleaned) * 100))
    if cents <= 0:
        raise ValueError("The amount must be greater than zero.")
    return cents


# --- API Routes ---

@app.route("/api/status", methods=["GET"])
def api_status():
    ok, err = init_database()
    return jsonify({
        "status": "connected" if ok else "error",
        "database": DB_NAME,
        "host": DB_HOST,
        "port": DB_PORT,
        "user": DB_USER,
        "error": err,
    })


@app.route("/api/login", methods=["POST"])
def api_login():
    data = request.get_json() or {}
    acc_no = str(data.get("accountNumber", "")).strip()
    pin = str(data.get("pin", "")).strip()

    if not re.match(r"^\d{6}$", acc_no):
        return jsonify({"error": "Enter your 6-digit account number."}), 400
    if not re.match(r"^\d{4}$", pin):
        return jsonify({"error": "Your PIN must be exactly 4 digits."}), 400

    conn = get_raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM accounts WHERE account_number = %s FOR UPDATE", (acc_no,))
            account = cur.fetchone()

            if not account:
                return jsonify({"error": "Account not found. Check the number or open a new account."}), 404

            # Check lockout
            locked_until = account.get("locked_until")
            if locked_until:
                now = datetime.now()
                if now < locked_until:
                    seconds = int((locked_until - now).total_seconds()) + 1
                    return jsonify({"error": f"This account is locked. Try again in {seconds} seconds."}), 403

            # Check PIN
            expected_hash = hash_pin(acc_no, pin)
            if account["pin_hash"] != expected_hash:
                attempts = account["failed_attempts"] + 1
                if attempts >= CONFIG["maxPinAttempts"]:
                    locked_time = datetime.now() + timedelta(seconds=CONFIG["lockSeconds"])
                    cur.execute(
                        "UPDATE accounts SET failed_attempts = 0, locked_until = %s WHERE id = %s",
                        (locked_time, account["id"]),
                    )
                    conn.commit()
                    return jsonify({
                        "error": f"Too many wrong PINs. The account is locked for {CONFIG['lockSeconds']} seconds."
                    }), 403
                else:
                    cur.execute(
                        "UPDATE accounts SET failed_attempts = %s WHERE id = %s",
                        (attempts, account["id"]),
                    )
                    conn.commit()
                    left = CONFIG["maxPinAttempts"] - attempts
                    return jsonify({
                        "error": f"Wrong PIN. {left} {'attempt' if left == 1 else 'attempts'} left."
                    }), 401

            # Successful login
            cur.execute(
                "UPDATE accounts SET failed_attempts = 0, locked_until = NULL WHERE id = %s",
                (account["id"],),
            )
            conn.commit()

            return jsonify({
                "accountNumber": account["account_number"],
                "name": account["holder_name"],
                "balance": account["balance_cents"],
            })
    finally:
        conn.close()


@app.route("/api/accounts", methods=["POST"])
def api_register():
    data = request.get_json() or {}
    name = str(data.get("name", "")).strip()
    pin = str(data.get("pin", "")).strip()
    pin_confirm = str(data.get("pinConfirm", "")).strip()
    deposit_text = str(data.get("depositText", "")).strip()

    if len(name) < 2:
        return jsonify({"error": "Enter your full name."}), 400
    if not re.match(r"^\d{4}$", pin):
        return jsonify({"error": "The PIN must be exactly 4 digits."}), 400
    if pin != pin_confirm:
        return jsonify({"error": "The two PINs do not match."}), 400

    opening_cents = 0
    if deposit_text:
        try:
            opening_cents = parse_cents(deposit_text)
            if opening_cents > CONFIG["maxDeposit"] * 100:
                return jsonify({"error": f"The opening deposit cannot be more than ${CONFIG['maxDeposit']:,.2f}."}), 400
        except ValueError as e:
            return jsonify({"error": str(e)}), 400

    conn = get_raw_connection()
    try:
        with conn.cursor() as cur:
            # Generate next 6-digit account number
            cur.execute("SELECT MAX(CAST(account_number AS UNSIGNED)) AS max_acc FROM accounts")
            row = cur.fetchone()
            max_acc = row["max_acc"] or 100000
            next_acc = str(max_acc + 1)

            pin_hash_val = hash_pin(next_acc, pin)
            cur.execute(
                """
                INSERT INTO accounts (account_number, holder_name, pin_hash, balance_cents, failed_attempts, locked_until)
                VALUES (%s, %s, %s, %s, 0, NULL)
                """,
                (next_acc, name, pin_hash_val, opening_cents),
            )
            account_id = cur.lastrowid

            if opening_cents > 0:
                cur.execute(
                    """
                    INSERT INTO transactions (id, account_id, type, amount_cents, balance_after_cents, note, created_at)
                    VALUES (%s, %s, 'deposit', %s, %s, 'Opening deposit', NOW())
                    """,
                    (str(uuid.uuid4()), account_id, opening_cents, opening_cents),
                )

            conn.commit()
            return jsonify({"accountNumber": next_acc, "name": name, "balance": opening_cents}), 201
    finally:
        conn.close()


@app.route("/api/accounts/<acc_no>/balance", methods=["GET"])
def api_balance(acc_no):
    conn = get_raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT account_number, holder_name, balance_cents FROM accounts WHERE account_number = %s", (acc_no,))
            account = cur.fetchone()
            if not account:
                return jsonify({"error": "Account not found."}), 404
            return jsonify({
                "accountNumber": account["account_number"],
                "name": account["holder_name"],
                "balance": account["balance_cents"],
            })
    finally:
        conn.close()


@app.route("/api/accounts/<acc_no>/deposit", methods=["POST"])
def api_deposit(acc_no):
    data = request.get_json() or {}
    try:
        cents = parse_cents(data.get("amountText", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if cents > CONFIG["maxDeposit"] * 100:
        return jsonify({"error": f"The most you can deposit at once is ${CONFIG['maxDeposit']:,.2f}."}), 400

    conn = get_raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, balance_cents FROM accounts WHERE account_number = %s FOR UPDATE", (acc_no,))
            account = cur.fetchone()
            if not account:
                return jsonify({"error": "Account not found."}), 404

            new_balance = account["balance_cents"] + cents
            cur.execute("UPDATE accounts SET balance_cents = %s WHERE id = %s", (new_balance, account["id"]))

            cur.execute(
                """
                INSERT INTO transactions (id, account_id, type, amount_cents, balance_after_cents, note, created_at)
                VALUES (%s, %s, 'deposit', %s, %s, 'Cash deposit', NOW())
                """,
                (str(uuid.uuid4()), account["id"], cents, new_balance),
            )
            conn.commit()

            return jsonify({"amount": cents, "balance": new_balance})
    finally:
        conn.close()


@app.route("/api/accounts/<acc_no>/withdraw", methods=["POST"])
def api_withdraw(acc_no):
    data = request.get_json() or {}
    try:
        cents = parse_cents(data.get("amountText", ""))
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    step_cents = CONFIG["withdrawStep"] * 100
    if cents % step_cents != 0:
        return jsonify({"error": f"Withdrawals must be in multiples of ${CONFIG['withdrawStep']:,.2f}."}), 400

    max_w_cents = CONFIG["maxWithdrawal"] * 100
    if cents > max_w_cents:
        return jsonify({"error": f"The most you can withdraw at once is ${CONFIG['maxWithdrawal']:,.2f}."}), 400

    conn = get_raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, balance_cents FROM accounts WHERE account_number = %s FOR UPDATE", (acc_no,))
            account = cur.fetchone()
            if not account:
                return jsonify({"error": "Account not found."}), 404

            if cents > account["balance_cents"]:
                avail = account["balance_cents"] / 100
                return jsonify({"error": f"Insufficient funds. Your balance is ${avail:,.2f}."}), 400

            new_balance = account["balance_cents"] - cents
            cur.execute("UPDATE accounts SET balance_cents = %s WHERE id = %s", (new_balance, account["id"]))

            cur.execute(
                """
                INSERT INTO transactions (id, account_id, type, amount_cents, balance_after_cents, note, created_at)
                VALUES (%s, %s, 'withdrawal', %s, %s, 'ATM withdrawal', NOW())
                """,
                (str(uuid.uuid4()), account["id"], cents, new_balance),
            )
            conn.commit()

            return jsonify({"amount": cents, "balance": new_balance})
    finally:
        conn.close()


@app.route("/api/accounts/<acc_no>/transactions", methods=["GET"])
def api_transactions(acc_no):
    t_type = request.args.get("type", "all").lower()
    search = request.args.get("search", "").strip().lower()

    conn = get_raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id FROM accounts WHERE account_number = %s", (acc_no,))
            account = cur.fetchone()
            if not account:
                return jsonify({"error": "Account not found."}), 404

            query = (
                "SELECT id, type, amount_cents, balance_after_cents, note, created_at "
                "FROM transactions WHERE account_id = %s "
            )
            params = [account["id"]]

            if t_type in ("deposit", "withdrawal"):
                query += "AND type = %s "
                params.append(t_type)

            query += "ORDER BY created_at DESC"
            cur.execute(query, params)
            rows = cur.fetchall()

            results = []
            for r in rows:
                amount_formatted = f"{r['amount_cents'] / 100:.2f}"
                note_text = r["note"] or ""
                if search and (search not in note_text.lower() and search not in amount_formatted):
                    continue
                results.append({
                    "id": r["id"],
                    "type": r["type"],
                    "amount": r["amount_cents"],
                    "balanceAfter": r["balance_after_cents"],
                    "note": note_text,
                    "date": r["created_at"].isoformat() if hasattr(r["created_at"], "isoformat") else str(r["created_at"]),
                })

            return jsonify({"transactions": results})
    finally:
        conn.close()


@app.route("/api/accounts/<acc_no>/pin", methods=["PUT"])
def api_change_pin(acc_no):
    data = request.get_json() or {}
    curr_pin = str(data.get("currentPin", "")).strip()
    new_pin = str(data.get("newPin", "")).strip()
    new_pin_confirm = str(data.get("newPinConfirm", "")).strip()

    if not re.match(r"^\d{4}$", curr_pin):
        return jsonify({"error": "Your current PIN must be exactly 4 digits."}), 400
    if not re.match(r"^\d{4}$", new_pin):
        return jsonify({"error": "The new PIN must be exactly 4 digits."}), 400
    if new_pin == curr_pin:
        return jsonify({"error": "The new PIN must be different from the current one."}), 400
    if new_pin != new_pin_confirm:
        return jsonify({"error": "The new PINs do not match."}), 400

    conn = get_raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT id, pin_hash FROM accounts WHERE account_number = %s FOR UPDATE", (acc_no,))
            account = cur.fetchone()
            if not account:
                return jsonify({"error": "Account not found."}), 404

            if account["pin_hash"] != hash_pin(acc_no, curr_pin):
                return jsonify({"error": "Your current PIN is wrong."}), 401

            new_hash = hash_pin(acc_no, new_pin)
            cur.execute("UPDATE accounts SET pin_hash = %s WHERE id = %s", (new_hash, account["id"]))
            conn.commit()
            return jsonify({"success": True})
    finally:
        conn.close()


@app.route("/api/reset-demo", methods=["POST"])
def api_reset_demo():
    conn = get_raw_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SET FOREIGN_KEY_CHECKS = 0")
            cur.execute("TRUNCATE TABLE transactions")
            cur.execute("TRUNCATE TABLE accounts")
            cur.execute("SET FOREIGN_KEY_CHECKS = 1")
            seed_demo_data(cur)
            conn.commit()
            return jsonify({"message": "MySQL demo data successfully reset."})
    finally:
        conn.close()


# Static file serving
@app.route("/")
def index():
    return send_from_directory(".", "index.html")


@app.route("/<path:filename>")
def static_files(filename):
    return send_from_directory(".", filename)


if __name__ == "__main__":
    print(f"Connecting to MySQL ({DB_USER}@{DB_HOST}:{DB_PORT})...")
    init_database()
    print(f"Starting ATM Simulator server on http://localhost:{PORT}")
    app.run(host="0.0.0.0", port=PORT, debug=False)
