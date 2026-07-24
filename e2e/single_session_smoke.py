from __future__ import annotations

import json
import os
from pathlib import Path

from playwright.sync_api import Route, sync_playwright


APP_URL = os.environ.get("CYCORE_E2E_APP_URL", "http://127.0.0.1:4210")
SCREENSHOT = Path(
    os.environ.get(
        "CYCORE_E2E_SCREENSHOT",
        "/tmp/cycore-blockly-single-session.png",
    )
)


def run() -> None:
    current_token = "edge-token"
    validation_count: dict[str, int] = {"edge-token": 0, "safari-token": 0}

    def mock_api(route: Route) -> None:
        if route.request.url.endswith("/eda/login/validate"):
            authorization = route.request.headers.get("authorization", "")
            request_token = authorization.removeprefix("Bearer ").strip()
            validation_count[request_token] = validation_count.get(request_token, 0) + 1
            if request_token == current_token:
                payload = {
                    "code": 200,
                    "message": "success",
                    "data": {
                        "userId": 7,
                        "username": "student",
                        "realName": "测试学生",
                        "userType": "01",
                        "token": request_token,
                    },
                }
            else:
                payload = {
                    "code": 401,
                    "message": "登录已在其他设备失效",
                    "data": None,
                }
        else:
            payload = {"code": 200, "message": "success", "data": []}

        route.fulfill(
            status=200,
            content_type="application/json",
            body=json.dumps(payload, ensure_ascii=False),
        )

    with sync_playwright() as playwright:
        edge_browser = playwright.chromium.launch(headless=True)
        safari_browser = playwright.webkit.launch(headless=True)
        edge_context = edge_browser.new_context(viewport={"width": 1440, "height": 900})
        edge_context.add_init_script(
            """
            window.__EDA_API_BASE_URL__ = `${location.origin}/mock-api`;
            sessionStorage.setItem('eda_token', 'edge-token');
            sessionStorage.setItem('userId', '7');
            localStorage.setItem('eda_user', JSON.stringify({
              userId: 7,
              username: 'student',
              realName: '测试学生',
              userType: '01'
            }));
            """
        )
        edge_page = edge_context.new_page()
        edge_page.route("**/mock-api/**", mock_api)
        edge_page.goto(f"{APP_URL}/#/main/guide", wait_until="networkidle")
        assert validation_count["edge-token"] >= 1

        current_token = "safari-token"
        safari_context = safari_browser.new_context(viewport={"width": 1440, "height": 900})
        safari_context.add_init_script(
            """
            window.__EDA_API_BASE_URL__ = `${location.origin}/mock-api`;
            sessionStorage.setItem('eda_token', 'safari-token');
            sessionStorage.setItem('userId', '7');
            localStorage.setItem('eda_user', JSON.stringify({
              userId: 7,
              username: 'student',
              realName: '测试学生',
              userType: '01'
            }));
            """
        )
        safari_page = safari_context.new_page()
        safari_page.route("**/mock-api/**", mock_api)
        safari_page.goto(f"{APP_URL}/#/main/guide", wait_until="networkidle")
        assert validation_count["safari-token"] >= 1

        edge_page.reload(wait_until="domcontentloaded")
        edge_page.wait_for_url("**/#/login?redirect=**", timeout=20_000)
        edge_page.get_by_text(
            "当前登录已失效，账号可能已在其他设备登录，请重新登录",
            exact=True,
        ).wait_for(state="visible")

        assert validation_count["edge-token"] >= 2
        assert edge_page.evaluate("sessionStorage.getItem('eda_token')") is None
        assert edge_page.evaluate("localStorage.getItem('eda_token')") is None
        SCREENSHOT.parent.mkdir(parents=True, exist_ok=True)
        edge_page.screenshot(path=str(SCREENSHOT), full_page=True)
        safari_browser.close()
        edge_browser.close()

    print(
        "PASS edge-safari-single-session "
        f"validations={validation_count} redirect=login tokenCleared=true "
        f"screenshot={SCREENSHOT}"
    )


if __name__ == "__main__":
    run()
