ALTER TABLE `memory_candidates` ADD `proposed_value_envelope` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `memory_candidates`
SET `proposed_value_envelope` = CASE
	WHEN (`proposed_value_ciphertext` IS NULL) <> (`proposed_value_iv` IS NULL) THEN NULL
	WHEN `proposed_value_ciphertext` IS NOT NULL THEN
		CASE WHEN (SELECT `data_key_version` FROM `users` WHERE `users`.`id` = `memory_candidates`.`user_id`) IS NULL
			THEN NULL
			ELSE json_object(
				'version', 1,
				'kind', 'encrypted',
				'ciphertext', `proposed_value_ciphertext`,
				'iv', `proposed_value_iv`,
				'keyVersion', (SELECT `data_key_version` FROM `users` WHERE `users`.`id` = `memory_candidates`.`user_id`)
			)
		END
	ELSE json_object('version', 1, 'kind', 'plain', 'value', json(`proposed_value_json`))
END;
--> statement-breakpoint
ALTER TABLE `fact_revisions` ADD `value_envelope` text NOT NULL DEFAULT '';
--> statement-breakpoint
UPDATE `fact_revisions`
SET `value_envelope` = CASE
	WHEN (`value_ciphertext` IS NULL) <> (`value_iv` IS NULL) THEN NULL
	WHEN `value_ciphertext` IS NOT NULL THEN json_object(
		'version', 1,
		'kind', 'encrypted',
		'ciphertext', `value_ciphertext`,
		'iv', `value_iv`,
		'keyVersion', `data_key_version`
	)
	ELSE json_object('version', 1, 'kind', 'plain', 'value', json(`value_json`))
END;
