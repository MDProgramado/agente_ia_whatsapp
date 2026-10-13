-- ===========================================================================
-- 0005_seed_admin — a linha do Admin em `app_users` (EQUP-01, R-027)
-- ===========================================================================
--
-- A tabela `app_users` foi criada no 0003, mas ficou vazia: a verdade do plano
-- 01-02 ("um único usuário administrador existe como **linha**", EQUP-01/R-027)
-- não era observável. Esta migration seeda a linha do Admin.
--
-- Sem `role` nem `password_hash` de propósito: R-027 adia perfis, e o schema
-- (`appUsers` em schema.ts) deliberadamente não tem essas colunas. O e-mail é
-- placeholder (`admin@whatsapp-prospect.local`) porque `email` é NOT NULL e
-- UNIQUE; a linha nasce aqui e o Admin pode trocar o e-mail depois.
--
-- Idempotente por natureza: o drizzle roda cada migration uma única vez
-- (`__drizzle_migrations`), e o `ON CONFLICT (email) DO NOTHING` protege a
-- re-execução manual.
INSERT INTO "app_users" ("name", "email")
VALUES ('Admin', 'admin@whatsapp-prospect.local')
ON CONFLICT ("email") DO NOTHING;