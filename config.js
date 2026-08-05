// Cascade Web — front-end config (CAS-317).
//
// Anon/public key only — Row-Level Security (confirmed ON, 2026-08-05) is what makes this
// safe to ship client-side. The service_role key must NEVER appear here; it stays a
// GitHub Actions secret used server-side by daily.yml.
//
// If this file is ever absent, the site still loads fine in guest mode (localStorage only) —
// it just shows a "connect your account" note in the account panel.

window.CASCADE_CONFIG = {
  SUPABASE_URL: "https://ypccfyatejejslzlfrbf.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlwY2NmeWF0ZWplanNsemxmcmJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQxNjY4ODEsImV4cCI6MjA5OTc0Mjg4MX0.P32M3PTqMKOu5DVEkIdaFAxiSOoXxqNbA6YIklgwrE4",
};
