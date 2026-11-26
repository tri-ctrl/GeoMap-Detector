FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgdal-dev g++ \
    && rm -rf /var/lib/apt/lists/*
COPY services/common/requirements.txt /common/requirements.txt
COPY services/ingestion/requirements.txt /ingestion/requirements.txt
RUN --mount=type=secret,id=custom_ca \
    if [ -s /run/secrets/custom_ca ]; then export PIP_CERT=/run/secrets/custom_ca; fi; \
    pip install --no-cache-dir -r /ingestion/requirements.txt
COPY services/ingestion/processor /app/processor
COPY services/common/ingestion_common /common/ingestion_common
ENV PYTHONPATH=/common PYTHONUNBUFFERED=1 GDAL_CACHEMAX=128 GDAL_NUM_THREADS=2 \
    OGR_GPKG_FOREIGN_KEY_CHECK=NO CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff"
RUN useradd --uid 10001 --create-home processor
USER processor
ENTRYPOINT ["python", "-m", "processor.main"]
