-- ATM Simulator MySQL Database Schema
-- Database: atm_db

CREATE DATABASE IF NOT EXISTS atm_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE atm_db;

-- Table: accounts
CREATE TABLE IF NOT EXISTS accounts (
  id              INT AUTO_INCREMENT PRIMARY KEY,
  account_number  CHAR(6) NOT NULL UNIQUE,
  holder_name     VARCHAR(40) NOT NULL,
  pin_hash        VARCHAR(255) NOT NULL,
  balance_cents   BIGINT NOT NULL DEFAULT 0,
  failed_attempts INT NOT NULL DEFAULT 0,
  locked_until    DATETIME NULL,
  created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Table: transactions
CREATE TABLE IF NOT EXISTS transactions (
  id                  VARCHAR(64) PRIMARY KEY,
  account_id          INT NOT NULL,
  type                ENUM('deposit', 'withdrawal') NOT NULL,
  amount_cents        BIGINT NOT NULL,
  balance_after_cents BIGINT NOT NULL,
  note                VARCHAR(100),
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Seed initial demo accounts if not already present
-- Account 100001: Alex Carter (PIN 1234 -> hash f7003d48)
INSERT IGNORE INTO accounts (id, account_number, holder_name, pin_hash, balance_cents, failed_attempts, locked_until)
VALUES (1, '100001', 'Alex Carter', 'f7003d48', 119000, 0, NULL);

-- Account 100002: Sam Rivera (PIN 4321 -> hash 27dbbc49)
INSERT IGNORE INTO accounts (id, account_number, holder_name, pin_hash, balance_cents, failed_attempts, locked_until)
VALUES (2, '100002', 'Sam Rivera', '27dbbc49', 25000, 0, NULL);

-- Seed initial demo transactions
INSERT IGNORE INTO transactions (id, account_id, type, amount_cents, balance_after_cents, note, created_at)
VALUES
  ('seed-tx-101', 1, 'deposit',    100000, 100000, 'Opening deposit', DATE_SUB(NOW(), INTERVAL 30 DAY)),
  ('seed-tx-102', 1, 'withdrawal',  20000,  80000, 'ATM withdrawal',  DATE_SUB(NOW(), INTERVAL 21 DAY)),
  ('seed-tx-103', 1, 'deposit',     45000, 125000, 'Cash deposit',    DATE_SUB(NOW(), INTERVAL 12 DAY)),
  ('seed-tx-104', 1, 'withdrawal',   6000, 119000, 'ATM withdrawal',  DATE_SUB(NOW(), INTERVAL 4 DAY)),
  ('seed-tx-201', 2, 'deposit',     30000,  30000, 'Opening deposit', DATE_SUB(NOW(), INTERVAL 15 DAY)),
  ('seed-tx-202', 2, 'withdrawal',   5000,  25000, 'ATM withdrawal',  DATE_SUB(NOW(), INTERVAL 2 DAY));
