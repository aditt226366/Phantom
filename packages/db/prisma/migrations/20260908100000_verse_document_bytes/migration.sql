-- The uploaded file itself, so the worker can extract from it.
--
-- ===========================================================================
-- WHY THIS IS A SECOND MIGRATION AND NOT AN EDIT TO THE FIRST
-- ===========================================================================
--
-- 20260908090000 had already been applied to dev and test when this gap was
-- found. Editing it would change its recorded checksum, forking every database
-- that ran the original - and the conventions are explicit that the remedy is
-- rebuilding every one of them, dev included. That is available here and would
-- not be in production, which is the whole reason the rule exists.
--
-- An additive migration costs nothing and is the shape that would be required
-- if this were already deployed, so it is the shape used now.
--
-- ===========================================================================
-- WHY THE BYTES ARE STORED AT ALL
-- ===========================================================================
--
-- Extraction happens in the worker, not in the upload request. A 300-page PDF
-- takes seconds to parse and a server action holding a connection for that long
-- is a request nobody's browser waits out - and the same file re-uploaded after
-- a timeout would be parsed twice.
--
-- So the upload writes bytes and enqueues, exactly as whatsapp_media and
-- kyc_documents already do, and the worker reads them back. The column is
-- nullable because a URL document has no file.

ALTER TABLE "kb_documents" ADD COLUMN "bytes" BYTEA;

-- EXTERNAL, not the type's default EXTENDED.
--
-- The same reasoning as whatsapp_media.bytes and kyc_documents.bytes: a
-- compressed value must be decompressed from the start to read any part of it,
-- so a chunked read becomes a full read every time. Nothing slices this column
-- today - extraction wants the whole file - but the setting is here because the
-- storage decision belongs with the column rather than with the first reader to
-- need it, and because the other two columns in this schema that hold file
-- bytes both learned it the expensive way.
ALTER TABLE "kb_documents" ALTER COLUMN "bytes" SET STORAGE EXTERNAL;

-- 10 MiB, twice the KYC cap.
--
-- A knowledge base document is a handbook or a price list rather than an
-- identity document, and the realistic legitimate upload is larger. The upload
-- path aborts the stream once the running byte count crosses the limit; this is
-- the backstop that does not depend on the caller having behaved, which is the
-- argument whatsapp_media_bytes_within_cap already makes.
ALTER TABLE "kb_documents"
  ADD CONSTRAINT kb_documents_bytes_within_cap
  CHECK ("bytes" IS NULL OR octet_length("bytes") <= 10485760);

-- byte_size cannot disagree with the bytes actually present.
--
-- The column is read by the UI to show a file size, and a stored number that
-- drifts from the content is a number nobody can trust and nothing recomputes.
ALTER TABLE "kb_documents"
  ADD CONSTRAINT kb_documents_byte_size_matches
  CHECK (
    "bytes" IS NULL
    OR "byte_size" IS NULL
    OR "byte_size" = octet_length("bytes")
  );

-- A FILE document must actually carry its file once it has been accepted.
--
-- Deliberately NOT enforced here as a CHECK. The row is written before the
-- bytes are streamed into it, so a constraint tying kind='FILE' to a non-null
-- bytes column would refuse the insert that creates the row. The upload path
-- writes both, and the ingestion handler fails the document with a readable
-- reason when the bytes are missing - which is the honest place for a check
-- whose subject arrives after the row does.
