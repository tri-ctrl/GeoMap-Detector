import json
import logging

from confluent_kafka import Consumer, Producer

from .config import settings

log = logging.getLogger(__name__)


def producer():
    return Producer({"bootstrap.servers": settings.kafka_bootstrap, "enable.idempotence": True,
                     "acks": "all", "delivery.timeout.ms": 30000})


def publish(client, topic, key, value):
    failures = []
    client.produce(topic, key=str(key), value=json.dumps(value, allow_nan=False).encode(),
                   on_delivery=lambda error, _message: failures.append(error) if error else None)
    pending = client.flush(35)
    if pending or failures:
        raise RuntimeError("Kafka delivery was not acknowledged")


def consumer(topic, group):
    client = Consumer({"bootstrap.servers": settings.kafka_bootstrap, "group.id": group,
                       "enable.auto.commit": False, "auto.offset.reset": "earliest",
                       "max.poll.interval.ms": 300000})
    client.subscribe([topic])
    return client


def dead_letter(client, message, error):
    # Bound poison messages; never copy file bytes or connection credentials into logs.
    publish(client, settings.dead_letter_topic, message.key() or b"invalid", {
        "topic": message.topic(), "partition": message.partition(), "offset": message.offset(),
        "error": str(error)[:500], "payload": message.value()[:8192].decode("utf-8", errors="replace")})
