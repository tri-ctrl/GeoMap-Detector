"""Idempotent local infrastructure initialization."""
from botocore.exceptions import ClientError
from confluent_kafka.admin import AdminClient, NewTopic
from confluent_kafka import KafkaError, KafkaException

from ingestion_common.config import settings
from ingestion_common.storage import s3
from .db import initialize, pool


def main():
    initialize()
    storage = s3()
    try:
        storage.head_bucket(Bucket=settings.bucket)
    except ClientError as error:
        if error.response["Error"]["Code"] not in ("404", "NoSuchBucket", "NotFound"):
            raise
        storage.create_bucket(Bucket=settings.bucket)
    admin = AdminClient({"bootstrap.servers": settings.kafka_bootstrap})
    existing = admin.list_topics(timeout=20).topics
    topics = [NewTopic(name, num_partitions=3, replication_factor=1, config={"retention.ms": "604800000"})
              for name in (settings.request_topic, settings.result_topic, settings.dead_letter_topic) if name not in existing]
    if topics:
        for future in admin.create_topics(topics).values():
            try:
                future.result(timeout=30)
            except KafkaException as error:
                if error.args[0].code() != KafkaError.TOPIC_ALREADY_EXISTS:
                    raise
    pool.close()


if __name__ == "__main__":
    main()
