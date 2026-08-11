CREATE VIRTUAL TABLE search_documents_fts USING fts5(
  document_id UNINDEXED,
  user_id UNINDEXED,
  text,
  source_label,
  tokenize = 'unicode61 remove_diacritics 2'
);
--> statement-breakpoint
CREATE TRIGGER search_documents_fts_insert AFTER INSERT ON search_documents
WHEN NEW.deleted_at IS NULL AND NEW.model_eligible = 1
BEGIN
  INSERT INTO search_documents_fts(document_id, user_id, text, source_label)
  VALUES (NEW.id, NEW.user_id, NEW.text, NEW.source_label);
END;
--> statement-breakpoint
CREATE TRIGGER search_documents_fts_delete AFTER DELETE ON search_documents
BEGIN
  DELETE FROM search_documents_fts WHERE document_id = OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER search_documents_fts_update AFTER UPDATE ON search_documents
BEGIN
  DELETE FROM search_documents_fts WHERE document_id = OLD.id;
  INSERT INTO search_documents_fts(document_id, user_id, text, source_label)
  SELECT NEW.id, NEW.user_id, NEW.text, NEW.source_label
  WHERE NEW.deleted_at IS NULL AND NEW.model_eligible = 1;
END;
