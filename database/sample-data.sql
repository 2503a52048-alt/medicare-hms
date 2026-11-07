-- =====================================================================
-- MediCare - reference data (specializations, health issues, settings)
-- Run AFTER schema.sql:  mysql -u root -p medicare_hms < database/sample-data.sql
--
-- Demo users (admin, doctors, patients) are NOT inserted here because their
-- passwords must be bcrypt-hashed. Create them with:  npm run db:seed
-- =====================================================================
USE medicare_hms;

INSERT INTO specializations (name, description, icon) VALUES
 ('General Physician', 'Fever, cold, infections and everyday health concerns', 'bi-bandaid'),
 ('Cardiologist',      'Heart and blood vessel care',                           'bi-heart-pulse'),
 ('Dermatologist',     'Skin, hair and nail care',                              'bi-droplet'),
 ('Ophthalmologist',   'Eye examination and vision care',                       'bi-eye'),
 ('Orthopedic',        'Bones, joints and muscles',                             'bi-activity'),
 ('Dentist',           'Teeth and oral health',                                 'bi-emoji-smile'),
 ('Neurologist',       'Brain, spine and nervous system',                       'bi-lightning-charge'),
 ('Pediatrician',      'Healthcare for infants, children and teens',            'bi-balloon-heart'),
 ('Gynecologist',      'Women''s health and pregnancy care',                    'bi-gender-female'),
 ('ENT Specialist',    'Ear, nose and throat care',                             'bi-ear');

INSERT INTO health_issues (name, specialization_id) VALUES
 ('Fever, cold or cough',            (SELECT id FROM specializations WHERE name='General Physician')),
 ('Body ache or weakness',           (SELECT id FROM specializations WHERE name='General Physician')),
 ('Chest pain or heart problems',    (SELECT id FROM specializations WHERE name='Cardiologist')),
 ('High blood pressure',             (SELECT id FROM specializations WHERE name='Cardiologist')),
 ('Skin rash, acne or allergy',      (SELECT id FROM specializations WHERE name='Dermatologist')),
 ('Hair fall',                       (SELECT id FROM specializations WHERE name='Dermatologist')),
 ('Eye pain or blurred vision',      (SELECT id FROM specializations WHERE name='Ophthalmologist')),
 ('Bone, joint or back pain',        (SELECT id FROM specializations WHERE name='Orthopedic')),
 ('Toothache or gum problems',       (SELECT id FROM specializations WHERE name='Dentist')),
 ('Headache, migraine or numbness',  (SELECT id FROM specializations WHERE name='Neurologist')),
 ('Child health or vaccination',     (SELECT id FROM specializations WHERE name='Pediatrician')),
 ('Pregnancy or women''s health',    (SELECT id FROM specializations WHERE name='Gynecologist')),
 ('Ear pain, sinus or sore throat',  (SELECT id FROM specializations WHERE name='ENT Specialist'));

INSERT INTO site_settings (setting_key, setting_value) VALUES
 ('hospital_name',     'MediCare Hospital'),
 ('hospital_tagline',  'Compassionate care, simple appointments'),
 ('hospital_phone',    '+91 40 0000 0000'),
 ('hospital_email',    'contact@medicare.example'),
 ('hospital_address',  '12 Health Avenue, Warangal, Telangana, India'),
 ('emergency_phone',   '108'),
 ('default_fee',       '200'),
 ('working_hours',     'Mon - Sat: 9:00 AM - 6:00 PM');
