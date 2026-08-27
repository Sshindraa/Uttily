-- Migration 0048 : Ajout du template de notification d'invitation d'équipe (Chantier 15.1)
ALTER TYPE notification_template ADD VALUE IF NOT EXISTS 'ORGANIZATION_INVITATION';
