import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from fastapi import HTTPException
from ingestion_common.contracts import IngestionRequest, IngestionResult, validate_source
from upload_api.app import Part
from upload_api.uploads import complete_object, validate_parts
from upload_api import bootstrap
from ingestion_common.config import settings


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.row = {"id": uuid4(), "size": 9, "part_size": 4, "object_key": "uploads/test/file", "s3_upload_id": "s3-id"}
        self.stored = [{"PartNumber": n, "ETag": f'"tag{n}"', "Size": size} for n, size in enumerate([4, 4, 1], 1)]
        self.parts = [Part(part_number=n, etag=f"tag{n}") for n in range(1, 4)]

    def test_exact_sizes_and_order(self):
        validate_parts(self.row, self.stored, self.parts)
        for bad in [self.parts[:-1], self.parts[::-1], [self.parts[0]] * 3]:
            with self.assertRaises(HTTPException):
                validate_parts(self.row, self.stored, bad)
        self.stored[-1]["Size"] = 2
        with self.assertRaises(HTTPException):
            validate_parts(self.row, self.stored, self.parts)

    def test_completion_recovers_storage_success_before_database_commit(self):
        storage = Mock()
        storage.head_object.return_value = {"ContentLength": 9, "Metadata": {"upload-id": str(self.row["id"])}}
        complete_object(storage, self.row, self.parts)
        storage.complete_multipart_upload.assert_not_called()

    def test_recovery_rejects_wrong_object(self):
        storage = Mock()
        storage.head_object.return_value = {"ContentLength": 9, "Metadata": {"upload-id": "other"}}
        with self.assertRaises(HTTPException):
            complete_object(storage, self.row, self.parts)

    def test_contract_rejects_wrong_bucket_and_artifact_scope(self):
        id_ = uuid4()
        request = IngestionRequest(upload_id=id_, attempt=1, source={"bucket": "test", "key": f"uploads/{id_}/a.csv", "name": "a.csv", "size": 10})
        validate_source(request, "test")
        with self.assertRaises(ValueError):
            validate_source(request, "other")
        with self.assertRaises(ValueError):
            IngestionResult(upload_id=id_, attempt=1, status="completed")
        with self.assertRaises(ValueError):
            IngestionResult(upload_id=id_, attempt=1, status="completed", processed_files=[{
                "id": "f", "name": "f", "kind": "vector", "bbox": [0, 0, 1, 1],
                "artifacts": [{"role": "data", "key": "uploads/other/a", "media_type": "application/json", "size": 1}]}])


class BootstrapTests(unittest.TestCase):
    def check_topics(self, existing):
        with patch.object(bootstrap, "initialize"), patch.object(bootstrap.pool, "close"), \
                patch.object(bootstrap, "s3") as storage, patch.object(bootstrap, "AdminClient") as admin:
            admin.return_value.list_topics.return_value.topics = existing
            admin.return_value.create_topics.return_value = {"test": Mock()}
            bootstrap.main()
            storage.return_value.create_bucket.assert_not_called()
            return admin.return_value.create_topics

    def test_restart_does_not_submit_empty_topic_list(self):
        create = self.check_topics({name: Mock() for name in (settings.request_topic, settings.result_topic, settings.dead_letter_topic)})
        create.assert_not_called()

    def test_first_start_creates_all_topics(self):
        create = self.check_topics({})
        self.assertEqual(len(create.call_args.args[0]), 3)


if __name__ == "__main__":
    unittest.main()
