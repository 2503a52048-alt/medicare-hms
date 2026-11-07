-- =====================================================================
-- MediCare - Hospital Appointment Management System
-- MySQL 8.0+ schema
-- Run:  mysql -u root -p < database/schema.sql
-- =====================================================================

CREATE DATABASE IF NOT EXISTS medicare_hms
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;
USE medicare_hms;

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS activity_logs, notifications, reviews, medical_records, prescriptions,
  payments, appointments, doctor_blocked_dates, doctor_availability, doctors, patients,
  health_issues, specializations, otp_codes, site_settings, users;
SET FOREIGN_KEY_CHECKS = 1;

-- 1. USERS (login identity for all three roles) -----------------------
CREATE TABLE users (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  email           VARCHAR(150) NOT NULL,
  mobile          VARCHAR(15)  NOT NULL,
  password_hash   VARCHAR(255) NOT NULL,
  role            ENUM('patient','doctor','admin') NOT NULL,
  mobile_verified TINYINT(1) NOT NULL DEFAULT 0,
  is_active       TINYINT(1) NOT NULL DEFAULT 1,
  last_login_at   DATETIME NULL,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_users_email (email),
  UNIQUE KEY uq_users_mobile (mobile),
  KEY idx_users_role (role)
) ENGINE=InnoDB;

-- 2. PATIENTS ----------------------------------------------------------
CREATE TABLE patients (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id     INT UNSIGNED NOT NULL,
  full_name   VARCHAR(120) NOT NULL,
  age         TINYINT UNSIGNED NOT NULL,
  gender      ENUM('male','female','other') NOT NULL,
  blood_group VARCHAR(5) NULL,
  address     VARCHAR(255) NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_patients_user (user_id),
  KEY idx_patients_name (full_name),
  CONSTRAINT fk_patients_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 3. SPECIALIZATIONS ---------------------------------------------------
CREATE TABLE specializations (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name        VARCHAR(80) NOT NULL,
  description VARCHAR(255) NULL,
  icon        VARCHAR(50) NOT NULL DEFAULT 'bi-heart-pulse',
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_spec_name (name)
) ENGINE=InnoDB;

-- Health issue -> specialization mapping (powers the recommendation feature)
CREATE TABLE health_issues (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name              VARCHAR(100) NOT NULL,
  specialization_id INT UNSIGNED NOT NULL,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_issue_name (name),
  CONSTRAINT fk_issue_spec FOREIGN KEY (specialization_id) REFERENCES specializations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 4. DOCTORS -----------------------------------------------------------
CREATE TABLE doctors (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           INT UNSIGNED NOT NULL,
  specialization_id INT UNSIGNED NOT NULL,
  full_name         VARCHAR(120) NOT NULL,
  qualifications    VARCHAR(255) NOT NULL,
  experience_years  TINYINT UNSIGNED NOT NULL DEFAULT 0,
  license_number    VARCHAR(50) NULL,
  phone             VARCHAR(15) NULL,
  consultation_fee  DECIMAL(10,2) NOT NULL DEFAULT 200.00,
  photo             VARCHAR(255) NULL,
  bio               TEXT NULL,
  is_verified       TINYINT(1) NOT NULL DEFAULT 0,
  is_active         TINYINT(1) NOT NULL DEFAULT 1,
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_doctors_user (user_id),
  UNIQUE KEY uq_doctors_license (license_number),
  KEY idx_doctors_spec (specialization_id),
  KEY idx_doctors_name (full_name),
  CONSTRAINT fk_doctors_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_doctors_spec FOREIGN KEY (specialization_id) REFERENCES specializations(id)
) ENGINE=InnoDB;

-- 5. DOCTOR AVAILABILITY (weekly schedule) -----------------------------
-- day_of_week: 0 = Sunday ... 6 = Saturday
CREATE TABLE doctor_availability (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doctor_id     INT UNSIGNED NOT NULL,
  day_of_week   TINYINT UNSIGNED NOT NULL,
  is_working    TINYINT(1) NOT NULL DEFAULT 1,
  start_time    TIME NOT NULL,
  end_time      TIME NOT NULL,
  break_start   TIME NULL,
  break_end     TIME NULL,
  slot_minutes  SMALLINT UNSIGNED NOT NULL DEFAULT 20,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_avail_doc_day (doctor_id, day_of_week),
  CONSTRAINT chk_avail_day CHECK (day_of_week BETWEEN 0 AND 6),
  CONSTRAINT fk_avail_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Dates a doctor has blocked (leave, conference, etc.)
CREATE TABLE doctor_blocked_dates (
  id           INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  doctor_id    INT UNSIGNED NOT NULL,
  blocked_date DATE NOT NULL,
  reason       VARCHAR(150) NULL,
  created_at   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_blocked (doctor_id, blocked_date),
  CONSTRAINT fk_blocked_doctor FOREIGN KEY (doctor_id) REFERENCES doctors(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 6. APPOINTMENTS ------------------------------------------------------
-- slot_lock is NULL for cancelled/rejected rows and 1 otherwise. The UNIQUE key
-- below therefore makes it impossible (at database level) for two live
-- appointments to share the same doctor + date + time, even under concurrent
-- requests. A cancelled slot becomes free again automatically.
CREATE TABLE appointments (
  id               INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_code VARCHAR(20) NOT NULL,
  patient_id       INT UNSIGNED NOT NULL,
  doctor_id        INT UNSIGNED NOT NULL,
  appointment_date DATE NOT NULL,
  slot_time        TIME NOT NULL,
  reason           VARCHAR(500) NOT NULL,
  status           ENUM('pending','confirmed','completed','cancelled','rejected') NOT NULL DEFAULT 'pending',
  cancelled_by     ENUM('patient','doctor','admin','system') NULL,
  cancel_reason    VARCHAR(255) NULL,
  consultation_notes TEXT NULL,
  reminder_sent    TINYINT(1) NOT NULL DEFAULT 0,
  slot_lock        TINYINT GENERATED ALWAYS AS (IF(status IN ('cancelled','rejected'), NULL, 1)) STORED,
  created_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at       TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_appt_code (appointment_code),
  UNIQUE KEY uq_appt_slot (doctor_id, appointment_date, slot_time, slot_lock),
  KEY idx_appt_patient (patient_id, appointment_date),
  KEY idx_appt_doctor_date (doctor_id, appointment_date),
  KEY idx_appt_status (status),
  CONSTRAINT fk_appt_patient FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT fk_appt_doctor  FOREIGN KEY (doctor_id)  REFERENCES doctors(id)
) ENGINE=InnoDB;

-- 7. PAYMENTS ----------------------------------------------------------
CREATE TABLE payments (
  id                 INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_id     INT UNSIGNED NOT NULL,
  patient_id         INT UNSIGNED NOT NULL,
  amount             DECIMAL(10,2) NOT NULL,
  method             ENUM('upi','card','netbanking') NOT NULL,
  status             ENUM('pending','success','failed','refunded') NOT NULL DEFAULT 'pending',
  mode               ENUM('test','live') NOT NULL DEFAULT 'test',
  transaction_ref    VARCHAR(40) NOT NULL,
  gateway_order_id   VARCHAR(80) NULL,
  gateway_payment_id VARCHAR(80) NULL,
  receipt_no         VARCHAR(30) NULL,
  paid_at            DATETIME NULL,
  created_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at         TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_pay_txn (transaction_ref),
  UNIQUE KEY uq_pay_receipt (receipt_no),
  KEY idx_pay_appt (appointment_id),
  KEY idx_pay_status (status),
  CONSTRAINT fk_pay_appt    FOREIGN KEY (appointment_id) REFERENCES appointments(id),
  CONSTRAINT fk_pay_patient FOREIGN KEY (patient_id)     REFERENCES patients(id)
) ENGINE=InnoDB;

-- 8. PRESCRIPTIONS -----------------------------------------------------
CREATE TABLE prescriptions (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_id INT UNSIGNED NOT NULL,
  doctor_id      INT UNSIGNED NOT NULL,
  patient_id     INT UNSIGNED NOT NULL,
  diagnosis      VARCHAR(255) NULL,
  medicines      TEXT NOT NULL,
  instructions   TEXT NULL,
  file_path      VARCHAR(255) NULL,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_rx_patient (patient_id),
  CONSTRAINT fk_rx_appt    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_rx_doctor  FOREIGN KEY (doctor_id)  REFERENCES doctors(id),
  CONSTRAINT fk_rx_patient FOREIGN KEY (patient_id) REFERENCES patients(id)
) ENGINE=InnoDB;

-- 9. MEDICAL RECORDS ---------------------------------------------------
CREATE TABLE medical_records (
  id          INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  patient_id  INT UNSIGNED NOT NULL,
  doctor_id   INT UNSIGNED NULL,
  record_type ENUM('allergy','condition','surgery','vaccination','lab_report','note') NOT NULL DEFAULT 'note',
  title       VARCHAR(150) NOT NULL,
  details     TEXT NULL,
  record_date DATE NOT NULL,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_rec_patient (patient_id, record_date),
  CONSTRAINT fk_rec_patient FOREIGN KEY (patient_id) REFERENCES patients(id) ON DELETE CASCADE,
  CONSTRAINT fk_rec_doctor  FOREIGN KEY (doctor_id)  REFERENCES doctors(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- 10. REVIEWS ----------------------------------------------------------
CREATE TABLE reviews (
  id             INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  appointment_id INT UNSIGNED NOT NULL,
  patient_id     INT UNSIGNED NOT NULL,
  doctor_id      INT UNSIGNED NOT NULL,
  rating         TINYINT UNSIGNED NOT NULL,
  comment        VARCHAR(500) NULL,
  is_visible     TINYINT(1) NOT NULL DEFAULT 1,
  created_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_review_appt (appointment_id),
  KEY idx_review_doctor (doctor_id),
  CONSTRAINT chk_rating CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT fk_review_appt    FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_review_patient FOREIGN KEY (patient_id) REFERENCES patients(id),
  CONSTRAINT fk_review_doctor  FOREIGN KEY (doctor_id)  REFERENCES doctors(id)
) ENGINE=InnoDB;

-- 11. NOTIFICATIONS ----------------------------------------------------
CREATE TABLE notifications (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  title      VARCHAR(150) NOT NULL,
  message    VARCHAR(500) NOT NULL,
  type       ENUM('appointment','payment','reminder','system') NOT NULL DEFAULT 'system',
  is_read    TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_notif_user (user_id, is_read),
  CONSTRAINT fk_notif_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 12. ACTIVITY LOGS ----------------------------------------------------
CREATE TABLE activity_logs (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NULL,
  action     VARCHAR(80) NOT NULL,
  details    VARCHAR(500) NULL,
  ip_address VARCHAR(45) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_log_user (user_id),
  KEY idx_log_created (created_at),
  CONSTRAINT fk_log_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

-- SUPPORT TABLES -------------------------------------------------------
-- One-time passwords (stored hashed, expire, limited attempts)
CREATE TABLE otp_codes (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  identifier VARCHAR(150) NOT NULL,
  purpose    ENUM('register','reset') NOT NULL,
  code_hash  VARCHAR(255) NOT NULL,
  attempts   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  used       TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_otp_lookup (identifier, purpose)
) ENGINE=InnoDB;

-- Admin-editable website settings (default fee, hospital info, etc.)
CREATE TABLE site_settings (
  setting_key   VARCHAR(60) PRIMARY KEY,
  setting_value VARCHAR(500) NOT NULL,
  updated_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB;
