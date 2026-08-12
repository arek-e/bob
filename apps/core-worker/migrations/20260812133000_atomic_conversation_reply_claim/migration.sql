CREATE TRIGGER `outbox_claim_closes_conversation_turn`
AFTER UPDATE OF `state` ON `outbox_messages`
WHEN OLD.`state` = 'pending'
	AND NEW.`state` = 'claimed'
	AND NEW.`claimed_at` IS NOT NULL
	AND NEW.`conversation_turn_id` IS NOT NULL
	AND NEW.`conversation_turn_revision` IS NOT NULL
BEGIN
	UPDATE `conversation_turns`
	SET
		`status` = 'replied',
		`replied_at` = NEW.`claimed_at`,
		`updated_at` = NEW.`claimed_at`
	WHERE `id` = NEW.`conversation_turn_id`
		AND `revision` = NEW.`conversation_turn_revision`
		AND `reply_outbox_id` = NEW.`id`
		AND `status` = 'committing';
END;
