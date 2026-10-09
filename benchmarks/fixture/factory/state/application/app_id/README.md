# state/application/<app_id>

Template folder. An application's four state files are `application.json`, `infrastructure.json`, `datastores.json`
and `datainfra.json`. Never put a secret value in them: secrets are referenced by name only (`secrets_user`, `*_ref`).
