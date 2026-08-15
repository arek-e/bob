ALTER TABLE `search_documents` ADD `search_text` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `search_documents` ADD `content_hash` text;--> statement-breakpoint
ALTER TABLE `search_documents` ADD `conflict_key` text;--> statement-breakpoint
ALTER TABLE `search_documents` ADD `valid_from` text;--> statement-breakpoint
ALTER TABLE `search_documents` ADD `valid_to` text;--> statement-breakpoint
CREATE INDEX `search_documents_owner_validity_idx` ON `search_documents` (`user_id`,`deleted_at`,`valid_from`,`valid_to`);--> statement-breakpoint
UPDATE `search_documents`
SET `search_text` = `text`,
    `valid_from` = COALESCE(`occurred_at`, `created_at`);--> statement-breakpoint
UPDATE `search_documents`
SET `conflict_key` = (
      SELECT `fact_id`
      FROM `fact_revisions`
      WHERE `fact_revisions`.`id` = `search_documents`.`source_id`
    ),
    `valid_from` = COALESCE(
      (
        SELECT COALESCE(`valid_from`, `observed_at`, `created_at`)
        FROM `fact_revisions`
        WHERE `fact_revisions`.`id` = `search_documents`.`source_id`
      ),
      `valid_from`
    ),
    `valid_to` = (
      SELECT `valid_to`
      FROM `fact_revisions`
      WHERE `fact_revisions`.`id` = `search_documents`.`source_id`
    ),
    `deleted_at` = CASE
      WHEN (
        SELECT `verification_status`
        FROM `fact_revisions`
        WHERE `fact_revisions`.`id` = `search_documents`.`source_id`
      ) = 'superseded' THEN NULL
      ELSE `deleted_at`
    END
WHERE `source_type` = 'fact_revision';--> statement-breakpoint
CREATE VIRTUAL TABLE retrieval_documents_fts USING fts5(
  document_id UNINDEXED,
  user_id UNINDEXED,
  search_text,
  source_label,
  tokenize = 'unicode61 remove_diacritics 2'
);--> statement-breakpoint
INSERT INTO retrieval_documents_fts(document_id, user_id, search_text, source_label)
SELECT id, user_id, search_text, source_label
FROM search_documents
WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE TRIGGER retrieval_documents_fts_insert AFTER INSERT ON search_documents
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO retrieval_documents_fts(document_id, user_id, search_text, source_label)
  VALUES (NEW.id, NEW.user_id, NEW.search_text, NEW.source_label);
END;--> statement-breakpoint
CREATE TRIGGER retrieval_documents_fts_remove AFTER DELETE ON search_documents
BEGIN
  DELETE FROM retrieval_documents_fts WHERE document_id = OLD.id;
END;--> statement-breakpoint
CREATE TRIGGER retrieval_documents_fts_update AFTER UPDATE ON search_documents
BEGIN
  DELETE FROM retrieval_documents_fts WHERE document_id = OLD.id;
  INSERT INTO retrieval_documents_fts(document_id, user_id, search_text, source_label)
  SELECT NEW.id, NEW.user_id, NEW.search_text, NEW.source_label
  WHERE NEW.deleted_at IS NULL;
END;
