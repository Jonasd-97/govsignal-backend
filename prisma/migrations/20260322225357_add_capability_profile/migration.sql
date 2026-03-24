-- AlterTable
ALTER TABLE "users" ADD COLUMN     "capabilityProfile" JSONB,
ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false;
