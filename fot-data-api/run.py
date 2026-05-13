"""Wrapper для запуска uvicorn на Windows.

На Windows psycopg async-режим несовместим с дефолтным uvicorn-loop'ом
(ProactorEventLoop) — нужен SelectorEventLoop. uvicorn выбирает loop ДО
импорта приложения, поэтому policy фикс в app/main.py не успевает
сработать. Этот wrapper выставляет policy раньше любых импортов uvicorn.

На Linux/macOS этот скрипт работает идентично `uvicorn app.main:app ...`,
никаких побочных эффектов — sys.platform != 'win32'.

Запуск:
  python run.py [--host 127.0.0.1] [--port 4001] [--reload]
"""

from __future__ import annotations

import argparse
import asyncio
import selectors
import sys

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=4001)
    parser.add_argument("--reload", action="store_true")
    args = parser.parse_args()
    config = uvicorn.Config(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        loop="asyncio",
    )
    server = uvicorn.Server(config)

    # На Windows + Python 3.14 нужен asyncio.Runner с явным SelectorEventLoop —
    # старый set_event_loop_policy() deprecated и не влияет на loop, выбираемый
    # uvicorn. На Linux/macOS просто asyncio.run().
    if sys.platform == "win32":
        with asyncio.Runner(loop_factory=lambda: asyncio.SelectorEventLoop(selectors.SelectSelector())) as runner:
            runner.run(server.serve())
    else:
        asyncio.run(server.serve())


if __name__ == "__main__":
    main()
