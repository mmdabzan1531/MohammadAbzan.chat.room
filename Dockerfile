FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV CHATROOM_DATA_DIR=/data PORT=8000
VOLUME /data
EXPOSE 8000
CMD gunicorn --worker-class gthread --workers 1 --threads 100 --bind 0.0.0.0:$PORT app:app
