FROM python:3.12-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends libgdal-dev g++ ffmpeg poppler-utils gdal-bin \
    && rm -rf /var/lib/apt/lists/*
COPY services/common/requirements.txt /common/requirements.txt
COPY services/ingestion/requirements.txt /ingestion/requirements.txt
RUN --mount=type=secret,id=custom_ca \
    if [ -s /run/secrets/custom_ca ]; then export PIP_CERT=/run/secrets/custom_ca; fi; \
    pip install --no-cache-dir -r /ingestion/requirements.txt
RUN --mount=type=secret,id=custom_ca \
    apt-get update && apt-get install -y --no-install-recommends make curl \
    && rm -rf /var/lib/apt/lists/* \
    && if [ -s /run/secrets/custom_ca ]; then export CURL_CA_BUNDLE=/run/secrets/custom_ca; fi \
    && curl -fL --retry 3 https://ftp.gnu.org/gnu/libredwg/libredwg-0.14.tar.gz -o /tmp/libredwg.tar.gz \
    && printf '%s  %s\n' cb6ee0b078c6d9e0f09d66f1feac33ba6342df88ae544e9f9335fab475218351 /tmp/libredwg.tar.gz | sha256sum -c - \
    && tar -xzf /tmp/libredwg.tar.gz -C /tmp \
    && cd /tmp/libredwg-0.14 && ./configure --disable-shared --disable-bindings --disable-docs CFLAGS=-O2 \
    && make -j2 && cp programs/dwgread programs/dxf2dwg /usr/local/bin/ \
    && cp COPYING /usr/local/share/libredwg-LICENSE && rm -rf /tmp/libredwg*
COPY services/ingestion/processor /app/processor
COPY services/common/ingestion_common /common/ingestion_common
ENV PYTHONPATH=/common PYTHONUNBUFFERED=1 GDAL_CACHEMAX=128 GDAL_NUM_THREADS=2 \
    OGR_GPKG_FOREIGN_KEY_CHECK=NO CPL_VSIL_CURL_ALLOWED_EXTENSIONS=".tif,.tiff"
RUN useradd --uid 10001 --create-home processor
USER processor
ENTRYPOINT ["python", "-m", "processor.main"]
