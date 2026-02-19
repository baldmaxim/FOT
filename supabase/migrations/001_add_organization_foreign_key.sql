-- Migration: Add foreign key constraint for organization_id in user_profiles
-- Created: 2026-02-19
-- Description: Adds FK constraint to link user_profiles.organization_id to organizations.id

-- Add foreign key constraint if it doesn't exist
DO $$
BEGIN
  -- Check if the constraint already exists
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'fk_user_profiles_organization'
    AND table_name = 'user_profiles'
  ) THEN
    -- Add the foreign key constraint
    ALTER TABLE user_profiles
    ADD CONSTRAINT fk_user_profiles_organization
    FOREIGN KEY (organization_id)
    REFERENCES organizations(id)
    ON DELETE SET NULL
    ON UPDATE CASCADE;
    
    RAISE NOTICE 'Foreign key constraint fk_user_profiles_organization added successfully';
  ELSE
    RAISE NOTICE 'Foreign key constraint fk_user_profiles_organization already exists';
  END IF;
END $$;

-- Create index on organization_id for better query performance (if not exists)
CREATE INDEX IF NOT EXISTS idx_user_profiles_organization_id
ON user_profiles(organization_id);
