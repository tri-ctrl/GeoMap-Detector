"""Native and container processors share bounded decoder cache/thread defaults."""

import os

for _key, _value in {
    "GDAL_CACHEMAX": "128",
    "GDAL_NUM_THREADS": "2",
    "OMP_NUM_THREADS": "1",
    "OPENBLAS_NUM_THREADS": "1",
}.items():
    os.environ.setdefault(_key, _value)
