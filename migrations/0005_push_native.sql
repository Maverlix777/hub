-- Native app tokens share the table. webpush rows keep endpoint/p256dh/auth.
-- apns rows use endpoint = 'apns:<token>' (unique key) and empty p256dh/auth.
ALTER TABLE push_subscriptions ADD COLUMN type TEXT NOT NULL DEFAULT 'webpush' CHECK (type IN ('webpush', 'apns'));
ALTER TABLE push_subscriptions ADD COLUMN token TEXT;
