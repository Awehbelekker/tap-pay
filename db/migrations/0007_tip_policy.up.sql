-- 0007 tip policy per merchant (M3, SPEC 7).
alter table merchants
  add column tip_min_cents bigint not null default 100 check (tip_min_cents > 0),
  add column tip_max_bp integer not null default 10000 check (tip_max_bp between 1 and 10000),
  add column tip_max_cents bigint check (tip_max_cents is null or tip_max_cents > 0),
  -- At most 4 presets (SPEC 7), each a whole percent from 1 to 100.
  add constraint merchants_tip_presets_valid check (
    cardinality(tip_presets) <= 4 and 1 <= all(tip_presets) and 100 >= all(tip_presets)
  );
