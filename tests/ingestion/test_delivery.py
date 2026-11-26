"""Run inside the API image against this Compose project's PostgreSQL."""
import unittest
from uuid import uuid4

from ingestion_common.contracts import IngestionResult
from upload_api.db import enqueue, initialize, pool
from upload_api.worker import apply_result
from upload_api.app import retry


class DeliveryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize()

    @classmethod
    def tearDownClass(cls):
        pool.close()

    def setUp(self):
        self.id = uuid4()
        with pool.connection() as conn:
            self.row = conn.execute("""INSERT INTO ingestion.uploads
                (id,name,size,fingerprint,content_type,object_key,s3_upload_id,part_size,status)
                VALUES (%s,'test.csv',10,'test','text/csv',%s,'test-id',5242880,'queued') RETURNING *""",
                (self.id, f"uploads/{self.id}/test.csv")).fetchone()

    def tearDown(self):
        with pool.connection() as conn:
            conn.execute("DELETE FROM ingestion.outbox WHERE upload_id=%s", (self.id,))
            conn.execute("DELETE FROM ingestion.uploads WHERE id=%s", (self.id,))

    def current(self):
        with pool.connection() as conn:
            return conn.execute("SELECT * FROM ingestion.uploads WHERE id=%s", (self.id,)).fetchone()

    def result(self, status, attempt=1):
        return IngestionResult(upload_id=self.id, attempt=attempt, status=status,
                               error="Invalid test data" if status == "failed" else None)

    def test_outbox_transaction_rolls_back_with_state(self):
        with self.assertRaisesRegex(RuntimeError, "crash"):
            with pool.connection() as conn:
                conn.execute("UPDATE ingestion.uploads SET status='processing' WHERE id=%s", (self.id,))
                enqueue(conn, self.row)
                raise RuntimeError("crash before commit")
        self.assertEqual(self.current()["status"], "queued")
        with pool.connection() as conn:
            self.assertIsNone(conn.execute("SELECT * FROM ingestion.outbox WHERE upload_id=%s", (self.id,)).fetchone())

    def test_stale_attempt_and_late_progress_cannot_replace_terminal_state(self):
        apply_result(self.result("failed", attempt=99))
        self.assertEqual(self.current()["status"], "queued")
        apply_result(self.result("failed"))
        apply_result(self.result("processing"))
        self.assertEqual(self.current()["status"], "failed")
        retried = retry(self.id)
        self.assertEqual(retried["attempt"], 2)
        apply_result(self.result("failed"))
        self.assertEqual(self.current()["status"], "queued")
        apply_result(self.result("processing", attempt=2))
        self.assertEqual(self.current()["status"], "processing")

    def test_duplicate_enqueue_is_idempotent(self):
        with pool.connection() as conn:
            enqueue(conn, self.row)
            enqueue(conn, self.row)
            count = conn.execute("SELECT count(*) AS n FROM ingestion.outbox WHERE upload_id=%s", (self.id,)).fetchone()["n"]
        self.assertEqual(count, 1)


if __name__ == "__main__":
    unittest.main()
