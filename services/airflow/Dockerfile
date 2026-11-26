ARG AIRFLOW_BASE_IMAGE=apache/airflow:2.11.1-python3.12
FROM ${AIRFLOW_BASE_IMAGE}
COPY services/common/requirements.txt /opt/geomap/common/requirements.txt
RUN --mount=type=secret,id=custom_ca,mode=0444 \
    if [ -s /run/secrets/custom_ca ]; then export PIP_CERT=/run/secrets/custom_ca; fi; \
    pip install --no-cache-dir "apache-airflow==2.11.1" "apache-airflow-providers-docker==4.4.3" \
    "docker==7.1.0" -r /opt/geomap/common/requirements.txt
COPY services/airflow/dags /opt/airflow/dags
COPY services/airflow/bridge.py /opt/geomap/bridge.py
COPY services/common/ingestion_common /opt/geomap/common/ingestion_common
ENV PYTHONPATH=/opt/geomap/common PYTHONUNBUFFERED=1
