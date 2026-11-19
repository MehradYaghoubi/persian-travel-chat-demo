# Persian Travel Chat Demo

A standalone demo adapted from the customer chat and offer picker in the travel chatbot project. Enter the route, date and passenger count, select sample flights or accommodation, then review a fictional cost breakdown. The conversation runs entirely in the browser and resets when the page is refreshed.

نسخه نمایشی فارسی برای وارد کردن مسیر، تاریخ و تعداد مسافران در قالب گفت‌وگو. نتیجه فقط یک پیش‌نمایش فرضی است و هیچ رزروی ثبت نمی‌شود.

## Screenshots

![Desktop chat with the original offer picker and fictional options](screenshots/desktop.png)

<details>
<summary>Mobile conversation</summary>

![Mobile view of the fictional cost breakdown](screenshots/mobile.png)

</details>

## Run locally

From the repository directory, start a local static server.

```sh
python -m http.server 8000 --bind 127.0.0.1
```

Open http://127.0.0.1:8000 in your browser. The demo has no package dependencies, backend, keys, or external services. Offer prices are fictional, and the flow ends at a preview.
