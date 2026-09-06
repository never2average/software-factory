# state/application/<app_id>

Template folder. Copy it to `state/application/<real_app_id>/` when stamping an application from a mold, then write `application.json`, `infrastructure.json`, `datastores.json`, `datainfra.json` conforming to the four schemas here. Never put secret values in these files; reference secret names only.
