import unittest
from uuid import uuid4
from fastapi import HTTPException
from ingestion_common.contracts import SUPPORTED_EXTENSIONS
from ingestion_common.formats import REFERENCE_EXTENSIONS
from upload_api.app import CreateFolder, MoveFile, create_directory, move_file, catalog
from upload_api.db import initialize, pool


class DirectoryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        initialize()

    @classmethod
    def tearDownClass(cls):
        pool.close()

    def setUp(self):
        self.folder = uuid4()
        self.child = uuid4()
        self.file = uuid4()
        create_directory(
            CreateFolder(id=self.folder, name="Directory " + str(self.folder))
        )
        create_directory(
            CreateFolder(id=self.child, name="Child", parent_id=self.folder)
        )
        with pool.connection() as conn:
            conn.execute(
                """INSERT INTO ingestion.uploads(id,name,size,fingerprint,content_type,object_key,s3_upload_id,part_size)
                VALUES (%s,'directory.csv',10,'test','text/csv',%s,'test',5242880)""",
                (self.file, f"uploads/{self.file}/directory.csv"),
            )

    def tearDown(self):
        with pool.connection() as conn:
            conn.execute("DELETE FROM ingestion.uploads WHERE id=%s", (self.file,))
            conn.execute("DELETE FROM ingestion.folders WHERE id=%s", (self.child,))
            conn.execute("DELETE FROM ingestion.folders WHERE id=%s", (self.folder,))

    def listing(self, folder):
        return catalog(limit=100, offset=0, folder=folder, q="directory.csv")["items"]

    def test_root_migration_and_scoped_move(self):
        self.assertIn(self.file, [row["id"] for row in self.listing("root")])
        self.assertNotIn(
            self.file, [row["id"] for row in self.listing(str(self.child))]
        )
        row = move_file(self.file, MoveFile(folder_id=self.child))
        self.assertEqual(row["folder_id"], self.child)
        self.assertNotIn(self.file, [row["id"] for row in self.listing("root")])
        self.assertIn(self.file, [row["id"] for row in self.listing(str(self.child))])
        move_file(self.file, MoveFile(folder_id=None))
        self.assertIn(self.file, [row["id"] for row in self.listing("root")])

    def test_folder_retry_duplicates_and_invalid_parent(self):
        same = create_directory(
            CreateFolder(id=self.child, name="Child", parent_id=self.folder)
        )
        self.assertEqual(same["id"], self.child)
        with self.assertRaises(HTTPException) as result:
            create_directory(
                CreateFolder(id=uuid4(), name="child", parent_id=self.folder)
            )
        self.assertEqual(result.exception.status_code, 409)
        with self.assertRaises(HTTPException):
            create_directory(CreateFolder(id=uuid4(), name="../escape"))
        with self.assertRaises(HTTPException):
            move_file(self.file, MoveFile(folder_id=uuid4()))

    def test_reference_extension_contract(self):
        self.assertTrue(set(REFERENCE_EXTENSIONS).issubset(SUPPORTED_EXTENSIONS))
        self.assertIn(".ecw", SUPPORTED_EXTENSIONS)
        self.assertIn(".giqreport", SUPPORTED_EXTENSIONS)
        self.assertIn(".mp4", SUPPORTED_EXTENSIONS)

    def test_directory_depth_is_bounded(self):
        created = []
        parent = self.child
        try:
            for index in range(10):
                id_ = uuid4()
                create_directory(
                    CreateFolder(id=id_, parent_id=parent, name=f"Level {index}")
                )
                created.append(id_)
                parent = id_
            with self.assertRaises(HTTPException) as result:
                create_directory(
                    CreateFolder(id=uuid4(), parent_id=parent, name="Too deep")
                )
            self.assertEqual(result.exception.status_code, 409)
        finally:
            with pool.connection() as conn:
                for id_ in reversed(created):
                    conn.execute("DELETE FROM ingestion.folders WHERE id=%s", (id_,))


if __name__ == "__main__":
    unittest.main()
