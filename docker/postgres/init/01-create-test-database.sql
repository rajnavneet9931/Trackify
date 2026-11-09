-- Runs once, when the Docker volume is first initialized.
-- Separate database for opt-in integration tests (TEST_DATABASE_URL).
CREATE DATABASE trackify_test OWNER trackify;
