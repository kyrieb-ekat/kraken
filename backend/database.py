import json
from datetime import datetime
from pathlib import Path

from sqlalchemy import (
    Boolean, Column, DateTime, Float, Integer, String, Text,
    create_engine, event
)
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

DB_PATH = Path(__file__).parent.parent / "data" / "kraken.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

engine = create_engine(f"sqlite:///{DB_PATH}", connect_args={"check_same_thread": False})

# Enable WAL mode for better concurrent read/write
@event.listens_for(engine, "connect")
def set_wal(dbapi_conn, _):
    dbapi_conn.execute("PRAGMA journal_mode=WAL")
    dbapi_conn.execute("PRAGMA foreign_keys=ON")

SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)


class Base(DeclarativeBase):
    pass


class Dataset(Base):
    __tablename__ = "datasets"
    id = Column(Integer, primary_key=True)
    name = Column(String, nullable=False)
    uploaded_at = Column(DateTime, default=datetime.utcnow)


class Folio(Base):
    __tablename__ = "folios"
    id = Column(Integer, primary_key=True)
    dataset_id = Column(Integer, nullable=False)
    folio_label = Column(String, nullable=False)
    image_url = Column(String)
    local_image_path = Column(String)
    # pending | downloading | done | failed
    image_status = Column(String, default="pending")
    segmented = Column(Boolean, default=False)
    # JSON list of fulltext_ms strings from CSV
    text_pool = Column(Text, default="[]")

    def get_text_pool(self) -> list[str]:
        return json.loads(self.text_pool or "[]")

    def set_text_pool(self, texts: list[str]):
        self.text_pool = json.dumps(texts, ensure_ascii=False)


class Line(Base):
    __tablename__ = "lines"
    id = Column(Integer, primary_key=True)
    folio_id = Column(Integer, nullable=False)
    line_index = Column(Integer, nullable=False)
    crop_path = Column(String)
    # JSON polygon from Kraken segment output: [[x,y], ...]
    polygon = Column(Text, default="[]")
    transcription = Column(Text)
    confirmed = Column(Boolean, default=False)

    def get_polygon(self):
        return json.loads(self.polygon or "[]")

    def set_polygon(self, pts):
        self.polygon = json.dumps(pts)


class Job(Base):
    __tablename__ = "jobs"
    id = Column(Integer, primary_key=True)
    # segment | compile | train
    type = Column(String, nullable=False)
    # pending | running | done | failed | stopped
    status = Column(String, default="pending")
    dataset_id = Column(Integer)
    folio_id = Column(Integer)
    started_at = Column(DateTime)
    finished_at = Column(DateTime)
    log_path = Column(String)
    model_path = Column(String)
    pid = Column(Integer)
    extra = Column(Text, default="{}")

    def get_extra(self) -> dict:
        return json.loads(self.extra or "{}")

    def set_extra(self, d: dict):
        self.extra = json.dumps(d)


Base.metadata.create_all(bind=engine)


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
