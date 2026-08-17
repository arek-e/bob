CREATE INDEX IF NOT EXISTS "search_documents_full_text_idx" ON "search_documents" USING gin (to_tsvector('simple', "search_text" || ' ' || "source_label"));
