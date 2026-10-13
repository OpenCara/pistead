-- A session started from a model, without choosing an agent, gets an agent of its own: every tool its host can carry
-- and no instructions. Such chat agents stay out of their author's agent catalog and cannot be revised or published.
ALTER TABLE agents ADD COLUMN chat INTEGER NOT NULL DEFAULT 0 CHECK (chat IN (0, 1));
