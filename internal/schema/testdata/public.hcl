# public スキーマ側。tenant.hcl のテーブルから参照される
schema "public" {}

extension "pg_trgm" {
  schema  = schema.public
  version = "1.6"
}

table "shops" {
  schema  = schema.public
  comment = "店舗"
  column "id" {
    type = serial
  }
  column "name" {
    type = text
  }
  column "created_at" {
    null    = false
    type    = timestamptz
    default = sql("now()")
  }
  primary_key {
    columns = [column.id]
  }
}

function "set_current_timestamp_updated_at" {
  schema = schema.public
  lang   = PLpgSQL
  return = trigger
  as     = <<-SQL
  BEGIN
    NEW.updated_at = now();
    RETURN NEW;
  END;
  SQL
}
