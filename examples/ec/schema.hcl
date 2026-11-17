# EC サイトのサンプル。mise run start（引数なし）でこのディレクトリを開く
schema "public" {
  comment = "EC サイト"
}

enum "product_status" {
  schema = schema.public
  values = ["DRAFT", "ON_SALE", "SOLD_OUT", "DISCONTINUED"]
}

enum "order_status" {
  schema = schema.public
  values = ["PENDING", "PAID", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"]
}

enum "payment_method" {
  schema = schema.public
  values = ["CREDIT_CARD", "BANK_TRANSFER", "CONVENIENCE_STORE", "CASH_ON_DELIVERY"]
}

enum "payment_status" {
  schema = schema.public
  values = ["AUTHORIZED", "CAPTURED", "FAILED", "REFUNDED"]
}
