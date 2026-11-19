@echo off
REM ========================================================
REM Launcher do Sistema de Prospeccao WhatsApp (Windows)
REM ========================================================
title Automacao WhatsApp - SDR Local

echo [1/3] Verificando conexao com PostgreSQL local...
powershell -NoProfile -Command "try { $tcp = New-Object Net.Sockets.TcpClient('127.0.0.1', 5432); $tcp.Close(); exit 0 } catch { exit 1 }"
if %ERRORLEVEL% NEQ 0 (
    echo [ERRO] PostgreSQL nao esta rodando na porta 5432. Inicie o servico do banco de dados primeiro.
    pause
    exit /b 1
)

echo [2/3] Rodando validacoes e iniciando o servidor...
cd /d "%~dp0.."

REM Abre o navegador padrao no painel de controle
start http://127.0.0.1:8787

REM Executa a aplicacao em desenvolvimento/producao
npm run dev

