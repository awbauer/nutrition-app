-- A meal can have several photos (angles, close-ups, the package and its label), read together
-- by the vision model. Photos live here, in order; nutrition_intake.media_r2_key keeps only a
-- voice clip. Existing meals move their one photo over (a text meal can
-- hold one too, merged in from a photo entry).
CREATE TABLE intake_photo (
  intake_id  TEXT NOT NULL REFERENCES nutrition_intake(id) ON DELETE CASCADE,
  position   INTEGER NOT NULL,
  r2_key     TEXT NOT NULL,
  PRIMARY KEY (intake_id, position)
);

INSERT INTO intake_photo (intake_id, position, r2_key)
  SELECT id, 0, media_r2_key FROM nutrition_intake WHERE media_r2_key IS NOT NULL
  AND (media_r2_key LIKE '%.jpg' OR media_r2_key LIKE '%.png' OR media_r2_key LIKE '%.webp' OR media_r2_key LIKE '%.heic');

UPDATE nutrition_intake SET media_r2_key = NULL WHERE media_r2_key IS NOT NULL
  AND (media_r2_key LIKE '%.jpg' OR media_r2_key LIKE '%.png' OR media_r2_key LIKE '%.webp' OR media_r2_key LIKE '%.heic');
