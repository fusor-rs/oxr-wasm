"""The reference's speed on the CPU, measured as the page measures itself: the time from the image
to the answer's first token (preprocessing, the vision tower, the visual vocabulary and the
prompt), and the tokens per second after it, greedy, with the KV cache. The reference is the golden
harness's: OXR-1.0's modeling code in transformers, f32, its Pillow image processor, SoMark's pixel
budget and the image's indicators as SoMark's vLLM plugin embeds them.

    python pytorch.py <checkpoint dir> <images dir> <tasks.json> <threads> <image>...
"""

import importlib.util
import json
import sys
import time
from pathlib import Path

import torch
from PIL import Image
from transformers import StoppingCriteria

PROMPTS = {
    "page": "Recognize the whole page content of the image.",
    "text": "Recognize the content of the image.",
    "table": "Recognize the table of the image into html format.",
    "formula": "Recognize the formula of the image into KaTex format.",
    "code": "Recognize the code of the image into markdown code format.",
    "chemistry": "Recognize the chemical structure of the image into SMILES.",
}
MIN_PIXELS = 200704
MAX_PIXELS = 921600
MAX_NEW_TOKENS = 4096
ENDS = [151643, 151645]

checkpoint, images, tasks, threads, *names = sys.argv[1:]
tasks = json.loads(Path(tasks).read_text())
torch.set_num_threads(int(threads))
spec = importlib.util.spec_from_file_location("oxr_reference", f"{checkpoint}/modeling_oxr.py", submodule_search_locations=[checkpoint])
reference = importlib.util.module_from_spec(spec)
sys.modules["oxr_reference"] = reference
spec.loader.exec_module(reference)
model = reference.OXR.from_pretrained(checkpoint, dtype=torch.float32).eval()
vocabulary = model.config.visual_vocab_size
model.indicator_token_indices = torch.arange(vocabulary - len(reference.INDICATOR_IDS), vocabulary)


class Clock(StoppingCriteria):
    """The time of every generated token; never stops the generation."""

    def __init__(self):
        self.times = []

    def __call__(self, input_ids, scores, **kwargs):
        self.times.append(time.perf_counter())
        return torch.zeros(input_ids.shape[0], dtype=torch.bool)


def read(image, task):
    """Seconds from the image to the first token and to the last, and the tokens written."""
    start = time.perf_counter()
    clock = Clock()
    messages = [{"role": "user", "content": [{"type": "image", "image": image}, {"type": "text", "text": PROMPTS[task]}]}]
    ids, pixels, grid = model.preprocess_inputs(messages, min_pixels=MIN_PIXELS, max_pixels=MAX_PIXELS)
    with torch.inference_mode():
        model.generate(ids, pixel_values=pixels, grid_thws=grid, max_new_tokens=MAX_NEW_TOKENS, do_sample=False, eos_token_id=ENDS, pad_token_id=ENDS[0], use_cache=True, stopping_criteria=[clock])
    return clock.times[0] - start, clock.times[-1] - start, len(clock.times)


for name in names:
    image = Image.open(next(Path(images).glob(f"{name}.*")))
    read(image, tasks[name])
    first, total, tokens = read(image, tasks[name])
    print(f"{name}: threads {threads}, first token {first:.2f}s, {tokens} tokens in {total:.2f}s ({(tokens - 1) / (total - first):.1f}/s after the first)", flush=True)
