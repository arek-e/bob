FROM postgres:17.6-alpine@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94
RUN apk add --no-cache restic tzdata
COPY --chmod=0555 apps/backup/backup.sh /usr/local/bin/bob-backup
COPY --chmod=0555 apps/backup/restore-verify.sh /usr/local/bin/bob-restore-verify
USER 70:70
ENTRYPOINT ["/usr/local/bin/bob-backup"]
