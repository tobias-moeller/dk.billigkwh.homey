import json
import requests


NET_COMPANY_URL = "https://billigkwh.dk/api/Electricity/GetTransports"
PRODUCTS_URL = "https://billigkwh.dk/api/Electricity/GetProducts"

def request_url(url):
    headers={
        "Content-Type":"application/json; charset=utf-8",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"
    }
    resp = requests.get(url=url, headers=headers)
    return resp.json()


def parse_json(json_data):
    return_list = []
    for item in json_data:
        return_item = {}
        return_item['id'] = item['uniqueId']
        return_item['label'] = {
            'da': item['name'],
            'en': item['name'],
        }
        return_list.append(return_item)
    return sorted(return_list, key=lambda d: d['label']['da'])
    

if __name__ == "__main__":
    x = input("1. Netselskaber \n2. Produkter\n")

    url = NET_COMPANY_URL
    if int(x) == 2:
        url = PRODUCTS_URL

    data = request_url(url)
    return_data = parse_json(data)
    f = open("output.txt", "w")
    f.write(json.dumps(return_data, indent=2, default=str, ensure_ascii=False))
    f.close()