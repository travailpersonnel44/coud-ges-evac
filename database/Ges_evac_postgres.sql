-- ============================================================================
-- BASE DE DONNÉES POSTGRESQL : Ges_evac_db
-- Plateforme Hospitalière — Hôpital du COUD (Dakar, Sénégal)
-- Compatible : PostgreSQL local (pgAdmin), Supabase, Neon.tech, Aiven
-- ============================================================================

-- 1. Table des comptes utilisateurs (Administrateurs & Téléopérateurs)
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  prenoms VARCHAR(100) NOT NULL,
  nom VARCHAR(100) NOT NULL,
  telephone VARCHAR(30) NOT NULL,
  login VARCHAR(60) NOT NULL UNIQUE,
  mot_de_passe VARCHAR(255) NOT NULL,
  role VARCHAR(30) NOT NULL DEFAULT 'teleoperateur',
  statut VARCHAR(30) NOT NULL DEFAULT 'approuve',
  reset_mot_de_passe VARCHAR(255) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Table des médecins
CREATE TABLE IF NOT EXISTS medecins (
  id SERIAL PRIMARY KEY,
  prenoms VARCHAR(100) NOT NULL,
  nom VARCHAR(100) NOT NULL,
  contact VARCHAR(30) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Table des services médicaux (Grand Campus & Sites)
CREATE TABLE IF NOT EXISTS services (
  id SERIAL PRIMARY KEY,
  nom_service VARCHAR(120) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 4. Table des équipes de secours
CREATE TABLE IF NOT EXISTS equipes_secours (
  id SERIAL PRIMARY KEY,
  libelle VARCHAR(100) NOT NULL UNIQUE,
  chef_equipe VARCHAR(150) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 5. Table des lieux de prise en charge (sauvegarde automatique)
CREATE TABLE IF NOT EXISTS lieux_prise_en_charge (
  id SERIAL PRIMARY KEY,
  nom_lieu VARCHAR(190) NOT NULL UNIQUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 6. Table des interventions médicales
CREATE TABLE IF NOT EXISTS interventions (
  id SERIAL PRIMARY KEY,
  matricule VARCHAR(50) NOT NULL,
  type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant',
  num_carte_etudiant VARCHAR(60) NOT NULL,
  prenoms VARCHAR(100) NOT NULL,
  nom VARCHAR(100) NOT NULL,
  date_naissance VARCHAR(30) NULL,
  lieu_naissance VARCHAR(120) NULL,
  contact VARCHAR(30) NULL,
  service_agent_adresse VARCHAR(190) NULL,
  lieu_prise_en_charge VARCHAR(190) NULL,
  destination VARCHAR(190) NULL,
  plaintes TEXT NOT NULL,
  date_heure_intervention VARCHAR(50) NOT NULL,
  agent_en_charge VARCHAR(150) NOT NULL,
  user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
  user_nom VARCHAR(150) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Table des évacuations classiques (avec ouverture/fermeture de garde)
CREATE TABLE IF NOT EXISTS evacuations (
  id SERIAL PRIMARY KEY,
  matricule VARCHAR(50) NOT NULL DEFAULT '',
  type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant',
  num_carte_etudiant VARCHAR(60) NOT NULL,
  prenoms VARCHAR(100) NOT NULL,
  nom VARCHAR(100) NOT NULL,
  contact VARCHAR(30) NULL,
  service_agent_adresse VARCHAR(190) NULL,
  motif TEXT NOT NULL,
  service VARCHAR(120) NOT NULL DEFAULT 'Urgence',
  medecin VARCHAR(150) NOT NULL,
  structure_evacuation VARCHAR(150) NOT NULL,
  date_heure VARCHAR(50) NOT NULL,
  statut_evacuation VARCHAR(30) NOT NULL DEFAULT 'Ouverte',
  date_heure_fermeture VARCHAR(50) NULL,
  infos_en_cours TEXT NULL,
  issue_evacuation VARCHAR(120) NULL,
  user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
  user_nom VARCHAR(150) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Table des évacuations spéciales (avec ouverture/fermeture de garde)
CREATE TABLE IF NOT EXISTS evacuations_speciales (
  id SERIAL PRIMARY KEY,
  matricule VARCHAR(50) NOT NULL DEFAULT '',
  type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant',
  num_carte VARCHAR(60) NOT NULL,
  prenoms VARCHAR(100) NOT NULL,
  nom VARCHAR(100) NOT NULL,
  contact VARCHAR(30) NULL,
  service_agent_adresse VARCHAR(190) NULL,
  service VARCHAR(120) NOT NULL DEFAULT 'Urgence',
  motifs TEXT NOT NULL,
  regulation VARCHAR(10) NOT NULL DEFAULT 'Non',
  accompagnement_medical VARCHAR(150) NULL,
  medecin VARCHAR(150) NOT NULL,
  structure VARCHAR(150) NOT NULL,
  date_heure VARCHAR(50) NOT NULL,
  statut_evacuation VARCHAR(30) NOT NULL DEFAULT 'Ouverte',
  date_heure_fermeture VARCHAR(50) NULL,
  infos_en_cours TEXT NULL,
  issue_evacuation VARCHAR(120) NULL,
  user_id INT NULL REFERENCES users(id) ON DELETE SET NULL,
  user_nom VARCHAR(150) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index pour accélérer les recherches de la plateforme hospitalière
CREATE INDEX IF NOT EXISTS idx_interventions_carte ON interventions(num_carte_etudiant);
CREATE INDEX IF NOT EXISTS idx_evacuations_carte ON evacuations(num_carte_etudiant);
CREATE INDEX IF NOT EXISTS idx_evac_spec_carte ON evacuations_speciales(num_carte);
CREATE INDEX IF NOT EXISTS idx_evacuations_statut ON evacuations(statut_evacuation);
CREATE INDEX IF NOT EXISTS idx_evac_spec_statut ON evacuations_speciales(statut_evacuation);

