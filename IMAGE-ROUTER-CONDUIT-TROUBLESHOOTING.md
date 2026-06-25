# ImageRouter Image Generation and Editing in Conduit

## Overview

This document records the findings and working solution for using the
ImageRouter OpenWebUI plugin from the Conduit iOS client.

The tested deployment uses:

- OpenWebUI at `https://chat.amirlabs.id`
- Conduit for iOS
- the ImageRouter OpenWebUI plugin
- ImageRouter's OpenAI-compatible endpoint
  `https://api.imagerouter.io/v1/openai`

The final setup supports:

- text-to-image in the OpenWebUI web interface;
- text-to-image in Conduit;
- image-to-image in the OpenWebUI web interface;
- image-to-image in Conduit;
- reuse of images generated in Conduit as image-to-image input.

## Why the Plugin Is Used

ImageRouter provides two OpenWebUI integration methods:

1. Native OpenWebUI image-generation configuration.
2. An OpenWebUI Pipe Function/plugin.

The native integration is simpler, but the ImageRouter documentation currently
limits it to text-to-image. Image-to-image and image editing require the plugin.
The plugin was therefore retained and modified for Conduit compatibility.

References:

- <https://docs.imagerouter.io/integrations/open-webui-native/>
- <https://docs.imagerouter.io/integrations/open-webui-plugin/>

## Problem 1: Generated Image Returns HTTP 401 in Conduit

### Symptom

Image generation completed successfully and the result was visible in the
OpenWebUI web interface, but Conduit displayed:

```text
HttpExceptionWithStatus: Invalid statusCode: 401
uri = https://storage.imagerouter.io/...
```

### Finding

The official plugin requested this response format:

```python
"response_format": "url"
```

It then returned the external ImageRouter storage URL as Markdown:

```python
image_url = response_data["data"][0]["url"]
yield f"![Generated Image]({image_url})"
```

Conduit only attaches the OpenWebUI authentication headers to images served
from the configured OpenWebUI origin. It intentionally does not send those
credentials to an unrelated external origin such as
`storage.imagerouter.io`.

The image-generation operation therefore succeeded, but Conduit's separate
image-download request received HTTP 401.

### Solution

Request base64 output from ImageRouter:

```python
"response_format": "b64_ephemeral"
```

Return the image as a data URI:

```python
encoded_image = response_data["data"][0]["b64_json"]
image_data_uri = f"data:image/webp;base64,{encoded_image}"
yield f"![Generated Image]({image_data_uri})"
```

This keeps the API key on the OpenWebUI server and removes Conduit's dependency
on the protected external storage URL.

## Problem 2: AsyncClient Rejects the Image-to-Image Multipart Request

### Symptom

Text-to-image worked, but image-to-image failed with:

```text
Attempted to send an sync request with an AsyncClient instance.
```

### Finding

The installed HTTPX version treated the multipart body created through
`files=` as a synchronous stream. That stream could not be sent through an
`httpx.AsyncClient`.

An intermediate attempt to represent form fields as a list of tuples produced
another compatibility error:

```text
sequence item 1: expected a bytes-like object, tuple found
```

### Solution

Build the `multipart/form-data` payload manually as one `bytes` object,
including:

- a unique boundary;
- normal text form fields;
- one or more `image[]` file fields;
- each file's filename and content type;
- the closing boundary.

Send the finished body through `AsyncClient` using `content=`:

```python
response = await client.post(
    endpoint,
    content=multipart_body,
    headers={
        "Authorization": authorization,
        "Content-Type": multipart_content_type,
        "Content-Length": str(len(multipart_body)),
        "Accept": "application/json",
    },
)
```

Because `multipart_body` is already bytes, HTTPX no longer needs to mix an
asynchronous client with a synchronous multipart stream.

## Problem 3: WebP Output Cannot Be Reused by Some Image Models

### Symptom

Image-to-image worked when a PNG file was uploaded from Conduit, but failed
when a previously generated Conduit image was used as input:

```text
ImageRouter API error: responded with HTTP InvalidParameter
```

The issue was reproduced with `wan/wan-2.7-image`.

### Finding

The customized plugin returned generated images as WebP. Conduit correctly
saved and reused that WebP image, but the selected ImageRouter model rejected
WebP input.

Images uploaded through the OpenWebUI web workflow were PNG, which explained
why the same image-edit operation worked from the web interface.

### Incorrect Workaround

Changing all generated output to PNG made the base64 response significantly
larger. Conduit then failed at the application level and displayed:

```text
Something went wrong
An unexpected error occurred
```

Returning every result as PNG was therefore not a practical solution.

### Final Solution

Keep generated output as WebP to minimize the base64 response size:

```python
"response_format": "b64_ephemeral",
"output_format": "webp",
```

Before sending any image-to-image request, normalize every input image on the
OpenWebUI server with Pillow:

1. Decode the data URI or download the source image.
2. Open it with Pillow.
3. Apply its EXIF orientation.
4. Select the first frame if animated.
5. Composite transparent images onto a white background.
6. Convert the image to RGB.
7. Resize it to a maximum dimension of 2048 pixels.
8. Encode it as JPEG.
9. Upload the normalized file as `image[]` with content type `image/jpeg`.

The essential normalization logic is:

```python
with Image.open(io.BytesIO(image_bytes)) as source_image:
    image = ImageOps.exif_transpose(source_image)

    if getattr(image, "is_animated", False):
        image.seek(0)

    has_alpha = (
        image.mode in ("RGBA", "LA")
        or (image.mode == "P" and "transparency" in image.info)
    )

    if has_alpha:
        rgba_image = image.convert("RGBA")
        background = Image.new("RGB", rgba_image.size, (255, 255, 255))
        background.paste(rgba_image, mask=rgba_image.getchannel("A"))
        image = background
    else:
        image = image.convert("RGB")

    if max(image.size) > 2048:
        image.thumbnail((2048, 2048), Image.Resampling.LANCZOS)

    output = io.BytesIO()
    image.save(output, format="JPEG", quality=92, optimize=True)

    filename = "image_0.jpg"
    image_bytes = output.getvalue()
    content_type = "image/jpeg"
```

This separates the two concerns:

- WebP remains the compact output format sent to Conduit.
- JPEG becomes the compatibility format sent back to ImageRouter for editing.

## Required Python Dependency

The Function uses Pillow:

```python
from PIL import Image, ImageOps
```

The Function metadata should include:

```text
requirements: pillow
```

If the OpenWebUI Function environment does not install the requirement
automatically, install Pillow in the OpenWebUI container or persistent Python
environment.

## Working Request Flow

### Text-to-image

```text
Conduit or OpenWebUI
        |
        v
ImageRouter Pipe Function
        |
        | JSON request
        | response_format=b64_ephemeral
        | output_format=webp
        v
ImageRouter API
        |
        | WebP base64
        v
Markdown data URI
        |
        v
Conduit and OpenWebUI render the image
```

### Image-to-image

```text
Conduit or OpenWebUI attachment
        |
        v
Pipe decodes the input
        |
        v
Pillow converts it to RGB JPEG
and limits it to 2048x2048
        |
        v
Manual multipart bytes request
with image[] = image/jpeg
        |
        v
ImageRouter API
        |
        | WebP base64 result
        v
Conduit and OpenWebUI render the image
```

## Final Configuration Summary

Use the plugin rather than the native ImageRouter integration when
image-to-image is required.

The working plugin behavior is:

```python
request_data = {
    "prompt": prompt or " ",
    "model": model,
    "quality": selected_quality,
    "response_format": "b64_ephemeral",
    "output_format": "webp",
}
```

For text-to-image, send JSON normally.

For image-to-image:

- normalize all input formats to JPEG;
- use the `image[]` multipart field expected by the ImageRouter plugin API;
- construct the multipart body as bytes;
- return the generated WebP as a base64 data URI.

## Validation Performed

The final implementation was tested successfully with:

- text-to-image from OpenWebUI web;
- text-to-image from Conduit iOS;
- image-to-image from OpenWebUI web;
- image-to-image from Conduit using PNG input;
- image-to-image from Conduit using a previously generated WebP image;
- rendering the generated result in both clients.

## Operational Notes

- Start a new chat after updating the Function so cached conversation payloads
  do not interfere with testing.
- Disable and re-enable the Function after replacing its source if OpenWebUI
  continues to use an older Function instance.
- Keep the ImageRouter API key in Function Valves. Do not send it from Conduit
  as a custom header.
- Avoid PNG base64 output for large generated images because it can exceed what
  the Conduit chat view handles reliably.
- The external `storage.imagerouter.io` URL is no longer used by the final
  workflow.
