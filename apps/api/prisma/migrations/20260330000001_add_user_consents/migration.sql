-- CreateTable user_consents (GDPR consent audit trail)
CREATE TABLE IF NOT EXISTS "user_consents" (
    "id"            TEXT NOT NULL,
    "userId"        TEXT NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "consentedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ipAddress"     TEXT,
    "userAgent"     TEXT,
    "channel"       TEXT NOT NULL DEFAULT 'app',

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX IF NOT EXISTS "user_consents_userId_idx" ON "user_consents"("userId");

-- AddForeignKey
ALTER TABLE "user_consents"
    ADD CONSTRAINT "user_consents_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
