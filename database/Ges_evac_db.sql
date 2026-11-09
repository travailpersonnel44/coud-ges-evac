-- Script de création de la base de données MySQL Ges_evac_db
-- Centre des Oeuvres Universitaires de Dakar (COUD) - Hôpital du COUD

CREATE DATABASE IF NOT EXISTS Ges_evac_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE Ges_evac_db;

-- 1. Table des utilisateurs (comptes : admin ou teleoperateur)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
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

-- 5. Table des médecins
CREATE TABLE IF NOT EXISTS medecins (
    id INT AUTO_INCREMENT PRIMARY KEY,
    prenoms VARCHAR(100) NOT NULL,
    nom VARCHAR(100) NOT NULL,
    contact VARCHAR(30) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 7. Table des services
CREATE TABLE IF NOT EXISTS services (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nom_service VARCHAR(120) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 8. Table des équipes de secours
CREATE TABLE IF NOT EXISTS equipes_secours (
    id INT AUTO_INCREMENT PRIMARY KEY,
    libelle VARCHAR(100) NOT NULL UNIQUE,
    chef_equipe VARCHAR(150) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 9. Table des lieux de prise en charge (sauvegardés automatiquement)
CREATE TABLE IF NOT EXISTS lieux_prise_en_charge (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nom_lieu VARCHAR(190) NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 3. Table des interventions
CREATE TABLE IF NOT EXISTS interventions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    matricule VARCHAR(50) NOT NULL,
    type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant',
    num_carte_etudiant VARCHAR(60) NOT NULL,
    prenoms VARCHAR(100) NOT NULL,
    nom VARCHAR(100) NOT NULL,
    date_naissance DATE NULL,
    lieu_naissance VARCHAR(120) NULL,
    contact VARCHAR(30) NULL,
    service_agent_adresse VARCHAR(190) NULL,
    lieu_prise_en_charge VARCHAR(190) NULL,
    destination VARCHAR(190) NULL,
    plaintes TEXT NOT NULL,
    date_heure_intervention DATETIME NOT NULL,
    agent_en_charge VARCHAR(150) NOT NULL,
    user_id INT NULL,
    user_nom VARCHAR(150) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 4. Table des évacuations classiques
CREATE TABLE IF NOT EXISTS evacuations (
    id INT AUTO_INCREMENT PRIMARY KEY,
    matricule VARCHAR(50) NOT NULL,
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
    date_heure DATETIME NOT NULL,
    statut_evacuation VARCHAR(30) NOT NULL DEFAULT 'Ouverte',
    date_heure_fermeture VARCHAR(50) NULL,
    infos_en_cours TEXT NULL,
    issue_evacuation VARCHAR(120) NULL,
    user_id INT NULL,
    user_nom VARCHAR(150) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);

-- 6. Table des évacuations spéciales
CREATE TABLE IF NOT EXISTS evacuations_speciales (
    id INT AUTO_INCREMENT PRIMARY KEY,
    matricule VARCHAR(50) NOT NULL,
    type_patient VARCHAR(40) NOT NULL DEFAULT 'Etudiant',
    num_carte VARCHAR(60) NOT NULL,
    prenoms VARCHAR(100) NOT NULL,
    nom VARCHAR(100) NOT NULL,
    contact VARCHAR(30) NULL,
    service_agent_adresse VARCHAR(190) NULL,
    service VARCHAR(120) NOT NULL DEFAULT 'Urgence',
    motifs TEXT NOT NULL,
    regulation ENUM('Oui', 'Non') NOT NULL DEFAULT 'Non',
    accompagnement_medical VARCHAR(150) NULL,
    medecin VARCHAR(150) NOT NULL,
    structure VARCHAR(150) NOT NULL,
    date_heure DATETIME DEFAULT CURRENT_TIMESTAMP,
    statut_evacuation VARCHAR(30) NOT NULL DEFAULT 'Ouverte',
    date_heure_fermeture VARCHAR(50) NULL,
    infos_en_cours TEXT NULL,
    issue_evacuation VARCHAR(120) NULL,
    user_id INT NULL,
    user_nom VARCHAR(150) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
);
