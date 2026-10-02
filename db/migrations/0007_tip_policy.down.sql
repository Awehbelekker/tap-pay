alter table merchants
  drop constraint if exists merchants_tip_presets_valid,
  drop column if exists tip_max_cents,
  drop column if exists tip_max_bp,
  drop column if exists tip_min_cents;
