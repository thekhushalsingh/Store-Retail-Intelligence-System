import os
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker
from redis import Redis

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://neondb_owner:npg_RX72UKNdwyAv@ep-jolly-bread-apwf6kyo-pooler.c-7.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

engine = create_engine(DATABASE_URL)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

Base = declarative_base()

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

redis_client = Redis.from_url(REDIS_URL, decode_responses=True)
