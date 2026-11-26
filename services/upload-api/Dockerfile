FROM python:3.12-slim
WORKDIR /app
COPY services/common/requirements.txt /common/requirements.txt
COPY services/upload-api/requirements.txt /upload-api/requirements.txt
RUN --mount=type=secret,id=custom_ca \
    if [ -s /run/secrets/custom_ca ]; then export PIP_CERT=/run/secrets/custom_ca; fi; \
    pip install --no-cache-dir -r /upload-api/requirements.txt
COPY services/upload-api/upload_api /app/upload_api
COPY services/common/ingestion_common /common/ingestion_common
ENV PYTHONPATH=/common PYTHONUNBUFFERED=1
RUN useradd --uid 10001 --create-home app
USER app
CMD ["uvicorn", "upload_api.app:app", "--host", "0.0.0.0", "--port", "8000"]
