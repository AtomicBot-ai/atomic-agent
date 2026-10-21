/**
 * Studio: the local diffusion catalog as it stood when this build was made,
 * used when the live copy cannot be read (offline, GitHub down, a schema the
 * parser refuses). Verbatim copy of AtomicBot-ai/atomic-chat-conf
 * models/diffusion.json at commit afd43921907906a02174d6dc956b31c3bc9dc5b1
 * (2026-10-09, schema_version 1). Regenerate it from that file; do not edit
 * by hand.
 */

export const DIFFUSION_CATALOG_BASELINE: unknown = {
  "$schema": "./schema.diffusion.json",
  "schema_version": 1,
  "updated_at": "2026-10-09T17:00:00Z",
  "families": [
    {
      "id": "z-image",
      "name": "Z-Image Turbo",
      "developer": "Tongyi-MAI",
      "modality": "image",
      "description": "Fast 6B text-to-image model; 8 steps, no negative prompt. Ships with a 2.4 GB GGUF Qwen3 text encoder (verified on the pinned sd.cpp build).",
      "license": "apache-2.0",
      "engines": [
        "sdcpp",
        "diffusers"
      ],
      "transformer": {
        "repo": "unsloth/Z-Image-Turbo-GGUF",
        "quants": [
          {
            "id": "q3_k_m",
            "label": "Q3_K_M",
            "filename": "z-image-turbo-Q3_K_M.gguf",
            "bytes": 4186161216,
            "sha256": "7070b605165c372833c21c6bd45e73b242cf0db261b4d5436039363f3dbd4e0e"
          },
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "z-image-turbo-Q4_K_M.gguf",
            "bytes": 5017613376,
            "sha256": "e6494f87de6abaf6a561924f50317a5f271fc34bb4222aabbd801197df8f7daa",
            "recommended": true
          },
          {
            "id": "q5_k_m",
            "label": "Q5_K_M",
            "filename": "z-image-turbo-Q5_K_M.gguf",
            "bytes": 5574444096,
            "sha256": "847e33003ae6e85121c62785d7f7213958d58287c932d0c2189a1c9a2d1f093a"
          },
          {
            "id": "q6_k",
            "label": "Q6_K",
            "filename": "z-image-turbo-Q6_K.gguf",
            "bytes": 5910505536,
            "sha256": "fc137d87b49e06fdd5230d67d6c8cfa42a9e1fd38b65ccd355882450c3eb1c82"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "z-image-turbo-Q8_0.gguf",
            "bytes": 7224707136,
            "sha256": "f163d60b0eb427469510b8226243d196574a18139a2e40c017409cfbda95ecfe"
          }
        ]
      },
      "vae": {
        "repo": "unsloth/Z-Image-Turbo-ComfyUI",
        "filename": "split_files/vae/ae.safetensors",
        "bytes": 335304388,
        "sha256": "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"
      },
      "text_encoders": [
        {
          "repo": "unsloth/Qwen3-4B-Instruct-2507-GGUF",
          "filename": "Qwen3-4B-Instruct-2507-Q4_K_M.gguf",
          "bytes": 2497281120,
          "sha256": "3605803b982cb64aead44f6c1b2ae36e3acdb41d8e46c8a94c6533bc4c67e597",
          "field": "llm"
        }
      ],
      "defaults": {
        "steps": 8,
        "cfg_scale": 1,
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          1,
          50
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": false,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "flux.2-klein",
      "name": "FLUX.2 Klein 4B",
      "developer": "Black Forest Labs",
      "modality": "image",
      "description": "4-step distilled FLUX.2 model with image editing; small and quick.",
      "license": "apache-2.0",
      "engines": [
        "sdcpp",
        "diffusers"
      ],
      "transformer": {
        "repo": "unsloth/FLUX.2-klein-4B-GGUF",
        "quants": [
          {
            "id": "q3_k_m",
            "label": "Q3_K_M",
            "filename": "flux-2-klein-4b-Q3_K_M.gguf",
            "bytes": 2124489280,
            "sha256": "0f27104f7b5842b7bfd5909645c60208cbb6b8d43f5d65f58b085f45ed18c9e1"
          },
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "flux-2-klein-4b-Q4_K_M.gguf",
            "bytes": 2604311104,
            "sha256": "0b25d143c8469b342bc5af3bce92b783bf6b0636d285f7b2f75e38af63af9a15",
            "recommended": true
          },
          {
            "id": "q5_k_m",
            "label": "Q5_K_M",
            "filename": "flux-2-klein-4b-Q5_K_M.gguf",
            "bytes": 3073368640,
            "sha256": "58c01c75fee2272eadb127f53e26dd05a5a8e7f812e37c36fa44603301f91e54"
          },
          {
            "id": "q6_k",
            "label": "Q6_K",
            "filename": "flux-2-klein-4b-Q6_K.gguf",
            "bytes": 3409273408,
            "sha256": "fb3b5430d9229f982616c7db084deff1db5035d0cb6558f2d4f704cfe5e609e2"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "flux-2-klein-4b-Q8_0.gguf",
            "bytes": 4300644928,
            "sha256": "24a812e8f9b640e21c784164ea48571d8017ca22873696f4badeeabb006d509c"
          }
        ]
      },
      "vae": {
        "repo": "unsloth/FLUX.2-VAE",
        "filename": "split_files/vae/flux2-vae.safetensors",
        "bytes": 336213556,
        "sha256": "d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5"
      },
      "vae_format": "flux2",
      "text_encoders": [
        {
          "repo": "unsloth/Z-Image-Turbo-ComfyUI",
          "filename": "split_files/text_encoders/qwen_3_4b.safetensors",
          "bytes": 8044982048,
          "sha256": "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
          "field": "llm"
        }
      ],
      "defaults": {
        "steps": 4,
        "cfg_scale": 1,
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          1,
          50
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": false,
        "workflows": [
          "create",
          "transform"
        ]
      }
    },
    {
      "id": "flux.1",
      "name": "FLUX.1 schnell",
      "developer": "Black Forest Labs",
      "modality": "image",
      "description": "12B 4-step model; the largest download because of its T5-XXL text encoder.",
      "license": "apache-2.0",
      "engines": [
        "sdcpp",
        "diffusers"
      ],
      "transformer": {
        "repo": "unsloth/FLUX.1-schnell-GGUF",
        "quants": [
          {
            "id": "q3_k_m",
            "label": "Q3_K_M",
            "filename": "flux1-schnell-Q3_K_M.gguf",
            "bytes": 5348017184,
            "sha256": "902449c98f64b3007f8afdbee21c16b6392803d92594a139f9ec14d5ee4aff0a"
          },
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "flux1-schnell-Q4_K_M.gguf",
            "bytes": 6911345696,
            "sha256": "09f32f18619f6bdb8f199c6bb107f8389429e1711312c36022c452af6866d9fa",
            "recommended": true
          },
          {
            "id": "q5_k_m",
            "label": "Q5_K_M",
            "filename": "flux1-schnell-Q5_K_M.gguf",
            "bytes": 8399029280,
            "sha256": "702b1e0130a1b1c7669f7f4fed01afdaaa896ee20608b8f09a6e619d66df561d"
          },
          {
            "id": "q6_k",
            "label": "Q6_K",
            "filename": "flux1-schnell-Q6_K.gguf",
            "bytes": 9827877920,
            "sha256": "f32ace1cbc1449a5c39e6598e3d9d46e0af501ae753463510e06b6f1ecef9824"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "flux1-schnell-Q8_0.gguf",
            "bytes": 12693980192,
            "sha256": "d397213d520384e2839342d6d057c367f49d197af65d742d502206e5c8f03921"
          }
        ]
      },
      "vae": {
        "repo": "unsloth/Z-Image-Turbo-ComfyUI",
        "filename": "split_files/vae/ae.safetensors",
        "bytes": 335304388,
        "sha256": "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"
      },
      "text_encoders": [
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "clip_l.safetensors",
          "bytes": 246144152,
          "sha256": "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
          "field": "clip_l"
        },
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "t5xxl_fp16.safetensors",
          "bytes": 9787841024,
          "sha256": "6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
          "field": "t5xxl"
        }
      ],
      "defaults": {
        "steps": 4,
        "cfg_scale": 1,
        "sampling_method": "euler",
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          1,
          50
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": false,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "flux.1-uncensored",
      "name": "FLUX.1 Anime Uncensored",
      "developer": "Zuntan",
      "modality": "image",
      "description": "Uncensored anime-focused FLUX.1 variant. May generate adult content; use responsibly and legally.",
      "license": "flux-1-dev-non-commercial-license",
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "Zuntan/FluxDev8AnimeNsfw",
        "quants": [
          {
            "id": "q4_k_s",
            "label": "Q4_K_S",
            "filename": "FluxDev8AnimeNsfw-Q4_K_S.gguf",
            "bytes": 6805988640,
            "sha256": "17f36122c695419e5a25773fa73c38b9d316366854a307705a38df6b82511714",
            "recommended": true
          }
        ]
      },
      "vae": {
        "repo": "unsloth/Z-Image-Turbo-ComfyUI",
        "filename": "split_files/vae/ae.safetensors",
        "bytes": 335304388,
        "sha256": "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"
      },
      "text_encoders": [
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "clip_l.safetensors",
          "bytes": 246144152,
          "sha256": "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
          "field": "clip_l"
        },
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "t5xxl_fp16.safetensors",
          "bytes": 9787841024,
          "sha256": "6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
          "field": "t5xxl"
        }
      ],
      "defaults": {
        "steps": 8,
        "cfg_scale": 1,
        "guidance": 3.5,
        "sampling_method": "euler",
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          4,
          50
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": true,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "flux.1-abliterated",
      "name": "FLUX.1 Dev Abliterated",
      "developer": "t8star",
      "modality": "image",
      "description": "Abliterated FLUX.1 Dev variant with fewer prompt restrictions and general-purpose rendering.",
      "license": "flux-1-dev-non-commercial-license",
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "t8star/flux.1-dev-abliterated-V2-GGUF",
        "quants": [
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "T8-flux.1-dev-abliterated-V2-GGUF-Q4_K_M.gguf",
            "bytes": 6940468512,
            "sha256": "f68579dfc3a5715f9618a3547f17708e952d2d3cd36703e40f2de7935e785168",
            "recommended": true
          },
          {
            "id": "q6_k",
            "label": "Q6_K",
            "filename": "T8-flux.1-dev-abliterated-V2-GGUF-Q6_K.gguf",
            "bytes": 9857000736,
            "sha256": "9a7ef0087e932ccff807b73b19b85aef75c0449883d01aa06c0ada4f1911608b"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "T8-flux.1-dev-abliterated-V2-GGUF-Q8_0.gguf",
            "bytes": 12723103008,
            "sha256": "aba8163ff644018da195212a1c33aeddbf802a0c2bba96abc584a2d0b6b42272"
          }
        ]
      },
      "vae": {
        "repo": "unsloth/Z-Image-Turbo-ComfyUI",
        "filename": "split_files/vae/ae.safetensors",
        "bytes": 335304388,
        "sha256": "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"
      },
      "text_encoders": [
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "clip_l.safetensors",
          "bytes": 246144152,
          "sha256": "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
          "field": "clip_l"
        },
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "t5xxl_fp16.safetensors",
          "bytes": 9787841024,
          "sha256": "6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
          "field": "t5xxl"
        }
      ],
      "defaults": {
        "steps": 20,
        "cfg_scale": 1,
        "guidance": 3.5,
        "sampling_method": "euler",
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          4,
          50
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": true,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "flux.1-nsfw-realism",
      "name": "FLUX.1 NSFW Realism",
      "developer": "ND911",
      "modality": "image",
      "description": "High-detail realistic adult FLUX.1 checkpoint for large-memory systems.",
      "license": "apache-2.0",
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "ND911/Test_Frankenstein",
        "quants": [
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "test_nsfw_2-Q8_0.gguf",
            "bytes": 12701062144,
            "sha256": "0604d5a078b87ea767f9f5d3da8747b2a23802e039beba4bfbdd5b76f502160b",
            "recommended": true
          }
        ]
      },
      "vae": {
        "repo": "unsloth/Z-Image-Turbo-ComfyUI",
        "filename": "split_files/vae/ae.safetensors",
        "bytes": 335304388,
        "sha256": "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"
      },
      "text_encoders": [
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "clip_l.safetensors",
          "bytes": 246144152,
          "sha256": "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
          "field": "clip_l"
        },
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "t5xxl_fp16.safetensors",
          "bytes": 9787841024,
          "sha256": "6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
          "field": "t5xxl"
        }
      ],
      "defaults": {
        "steps": 12,
        "cfg_scale": 3.5,
        "sampling_method": "euler",
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          4,
          50
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": true,
        "guidance": false,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "flux.1-krea",
      "name": "FLUX.1 Krea Dev",
      "developer": "Black Forest Labs × Krea",
      "modality": "image",
      "description": "Krea's opinionated FLUX.1 Dev fine-tune for natural detail and less synthetic-looking images.",
      "license": "flux-1-dev-non-commercial-license",
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "QuantStack/FLUX.1-Krea-dev-GGUF",
        "quants": [
          {
            "id": "q3_k_m",
            "label": "Q3_K_M",
            "filename": "flux1-krea-dev-Q3_K_M.gguf",
            "bytes": 5368489248,
            "sha256": "f206de1dbd783b8775541fdc3031f156550932afe942fa3169035e99ccc5e45e"
          },
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "flux1-krea-dev-Q4_K_M.gguf",
            "bytes": 6931817760,
            "sha256": "cf199b88509be2b3476a3372ff03eaaa662cb2b5d3710abf939ebb4838dbdcaf",
            "recommended": true
          },
          {
            "id": "q5_k_m",
            "label": "Q5_K_M",
            "filename": "flux1-krea-dev-Q5_K_M.gguf",
            "bytes": 8419501344,
            "sha256": "e2cc8bf21c21c8159fa5f2a72d650185f188f21692989810e3417172ff89723f"
          },
          {
            "id": "q6_k",
            "label": "Q6_K",
            "filename": "flux1-krea-dev-Q6_K.gguf",
            "bytes": 9848349984,
            "sha256": "c50c13ebe1207b2c87b251ccf3a55b9eb54c84f73cee62503d17acd8a460953e"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "flux1-krea-dev-Q8_0.gguf",
            "bytes": 12714452256,
            "sha256": "0d085b1e3ae0b90e5dbf74da049a80a565617de622a147d28ee37a07761fbd90"
          }
        ]
      },
      "vae": {
        "repo": "unsloth/Z-Image-Turbo-ComfyUI",
        "filename": "split_files/vae/ae.safetensors",
        "bytes": 335304388,
        "sha256": "afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38"
      },
      "text_encoders": [
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "clip_l.safetensors",
          "bytes": 246144152,
          "sha256": "660c6f5b1abae9dc498ac2d21e1347d2abdb0cf6c0c0c8576cd796491d9a6cdd",
          "field": "clip_l"
        },
        {
          "repo": "unsloth/flux-text-encoders",
          "filename": "t5xxl_fp16.safetensors",
          "bytes": 9787841024,
          "sha256": "6e480b09fae049a72d2a8c5fbccb8d3e92febeb233bbe9dfe7256958a9167635",
          "field": "t5xxl"
        }
      ],
      "defaults": {
        "steps": 20,
        "cfg_scale": 1,
        "guidance": 3.5,
        "sampling_method": "euler",
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          4,
          50
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": true,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "krea-2-turbo",
      "name": "Krea 2 Turbo",
      "developer": "Krea",
      "modality": "image",
      "description": "Fast 12B text-to-image model distilled for 8-step generation. Q3_K_M is the low-memory option, Q4_K_M is recommended, and Q5_K_S is the high-quality option. GATED COMMUNITY LICENSE: commercial use is subject to the Krea 2 Community License, including its revenue threshold and acceptable-use requirements; it is not unrestricted. Official model: https://huggingface.co/krea/Krea-2-Turbo. License: https://cdn.jsdelivr.net/gh/krea-ai/krea-2@db3984fbc6e13b34c0064990fc2d95ac64d00058/assets/hf_samples/LICENSE.pdf.",
      "license": "krea-2-community-license",
      "gated": true,
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "realrebelai/KREA-2_GGUFs",
        "quants": [
          {
            "id": "q3_k_m",
            "label": "Q3_K_M",
            "filename": "TURBO/Krea-2-Turbo-Q3_K_M.gguf",
            "bytes": 5514578016,
            "sha256": "9a8917ac175e0287d86f43da7d520ee0efe4a24f5250d9cd7ae0b0abf4ef5f62"
          },
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "TURBO/Krea-2-Turbo-Q4_K_M.gguf",
            "bytes": 7216993376,
            "sha256": "273a98be1afe317bc7228403b6434647eaf866cebe6aff1980c401b950473807",
            "recommended": true
          },
          {
            "id": "q5_k_s",
            "label": "Q5_K_S",
            "filename": "TURBO/Krea-2-Turbo-Q5_K_S.gguf",
            "bytes": 8819266656,
            "sha256": "2d9a6bfb1b9ef512b040af72b59ce8c4a564f834a083747f3a6e7d3781e8b6dd"
          }
        ]
      },
      "vae": {
        "repo": "Comfy-Org/Wan_2.1_ComfyUI_repackaged",
        "filename": "split_files/vae/wan_2.1_vae.safetensors",
        "bytes": 253815318,
        "sha256": "2fc39d31359a4b0a64f55876d8ff7fa8d780956ae2cb13463b0223e15148976b"
      },
      "text_encoders": [
        {
          "repo": "Qwen/Qwen3-VL-4B-Instruct-GGUF",
          "filename": "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
          "bytes": 2497281664,
          "sha256": "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a",
          "field": "llm"
        }
      ],
      "defaults": {
        "steps": 8,
        "cfg_scale": 1,
        "sampling_method": "euler",
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          1,
          20
        ],
        "dims": [
          512,
          2048
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": false,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "qwen-image",
      "name": "Qwen-Image",
      "developer": "Qwen",
      "modality": "image",
      "description": "20B model with strong text rendering; slow, needs a large GPU or CPU offload.",
      "license": "apache-2.0",
      "engines": [
        "sdcpp",
        "diffusers"
      ],
      "transformer": {
        "repo": "unsloth/Qwen-Image-GGUF",
        "quants": [
          {
            "id": "q3_k_m",
            "label": "Q3_K_M",
            "filename": "qwen-image-Q3_K_M.gguf",
            "bytes": 9744742944,
            "sha256": "e60bcea6b409c33157dd08e18cd672532501e118ba30fe5c269007af29b6e860"
          },
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "qwen-image-Q4_K_M.gguf",
            "bytes": 13127088672,
            "sha256": "eb2d4719dda7c73c52c1685673d173f4c1407e78688c2869352cef3ef7ba3819",
            "recommended": true
          },
          {
            "id": "q5_k_m",
            "label": "Q5_K_M",
            "filename": "qwen-image-Q5_K_M.gguf",
            "bytes": 15000074784,
            "sha256": "75b928f215cc6aa471d8e5f260af9e36baa42bd3caac333f4e9894aa1b67b4c7"
          },
          {
            "id": "q6_k",
            "label": "Q6_K",
            "filename": "qwen-image-Q6_K.gguf",
            "bytes": 16824990240,
            "sha256": "d3331594de0eb342bad2b64bcfe9c9c12ae9cf4f3c6bda2851cc394d3ecc2593"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "qwen-image-Q8_0.gguf",
            "bytes": 21761817120,
            "sha256": "43142b32778dc0568c27395abc6f8291ac53f1de0b98eed919712cf161f248de"
          }
        ]
      },
      "vae": {
        "repo": "unsloth/Qwen-Image-ComfyUI",
        "filename": "split_files/vae/qwen_image_vae.safetensors",
        "bytes": 253806246,
        "sha256": "a70580f0213e67967ee9c95f05bb400e8fb08307e017a924bf3441223e023d1f"
      },
      "text_encoders": [
        {
          "repo": "unsloth/Qwen2.5-VL-7B-Instruct-GGUF",
          "filename": "Qwen2.5-VL-7B-Instruct-Q4_K_M.gguf",
          "bytes": 4683072384,
          "sha256": "d16776dcd9a28d42758c2958ed3a752aabf20a305252cd64ff2be72b4a78c503",
          "field": "qwen2vl"
        }
      ],
      "defaults": {
        "steps": 20,
        "cfg_scale": 2.5,
        "sampling_method": "euler",
        "flow_shift": 3,
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          1,
          50
        ],
        "dims": [
          256,
          1024
        ],
        "dim_multiple": 16
      },
      "capabilities": {
        "negative_prompt": true,
        "guidance": false,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "qwen-image-2.1",
      "name": "Qwen-Image-2.1",
      "developer": "Qwen",
      "modality": "image",
      "description": "Unified 7B text-to-image and image-editing model with native RGBA output and support for up to 10 reference images. NON-COMMERCIAL ONLY: licensed for research and evaluation under the Qwen Research License; commercial use requires a separate license. Qwen is Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. GGUF packaging is provided by stable-diffusion.cpp author leejet.",
      "license": "qwen-research-non-commercial",
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "leejet/Qwen-Image-2.1-GGUF",
        "quants": [
          {
            "id": "q4_k",
            "label": "Q4_K",
            "filename": "qwen_image_2.1-Q4_K.gguf",
            "bytes": 4197494816,
            "sha256": "29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2",
            "recommended": true
          }
        ]
      },
      "vae": {
        "repo": "Comfy-Org/Qwen-Image-2.1",
        "filename": "vae/qwen_image_2.1_vae_bf16.safetensors",
        "bytes": 675509688,
        "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
      },
      "text_encoders": [
        {
          "repo": "Qwen/Qwen3-VL-8B-Instruct-GGUF",
          "filename": "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
          "bytes": 5027784800,
          "sha256": "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
          "field": "llm"
        },
        {
          "repo": "Qwen/Qwen3-VL-8B-Instruct-GGUF",
          "filename": "mmproj-Qwen3VL-8B-Instruct-F16.gguf",
          "bytes": 1159029824,
          "sha256": "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38",
          "field": "llm_vision"
        }
      ],
      "defaults": {
        "steps": 40,
        "cfg_scale": 6,
        "sampling_method": "euler",
        "width": 1024,
        "height": 1024
      },
      "ranges": {
        "steps": [
          1,
          50
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 32
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": false,
        "workflows": [
          "create",
          "reference",
          "edit"
        ]
      }
    },
    {
      "id": "qwen-image-2.1-turbo",
      "name": "Qwen-Image-2.1-Turbo",
      "developer": "Qwen",
      "modality": "image",
      "description": "Qwen-Image-2.1 distilled to 8 denoising steps at CFG 1: the same 7B text-to-image and image-editing model, several times faster, sharing the text encoder, vision projector and VAE of Qwen-Image-2.1. NON-COMMERCIAL ONLY: licensed for research and evaluation under the Qwen Research License; commercial use requires a separate license. Qwen is Copyright (c) 2026 Hangzhou Tongyi Laboratory Technology Co., Ltd. GGUF packaging is provided by Atomic Chat.",
      "license": "qwen-research-non-commercial",
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "AtomicChat/Qwen-Image-2.1-Turbo-GGUF",
        "quants": [
          {
            "id": "ad_q2_k",
            "label": "AD_Q2_K",
            "filename": "Qwen-Image-2.1-Turbo-AD-Q2_K.gguf",
            "bytes": 2553333472,
            "sha256": "8ab2888f605030a894c6238d978f51427bfde6732f4a112c71cff0439e265d04"
          },
          {
            "id": "ad_q3_k",
            "label": "AD_Q3_K",
            "filename": "Qwen-Image-2.1-Turbo-AD-Q3_K.gguf",
            "bytes": 3599812320,
            "sha256": "544bef750b2c4b058fe5f646b459602d6e468a914afc106fa1fc9dff00169d9f"
          },
          {
            "id": "ad_q4_k",
            "label": "AD_Q4_K",
            "filename": "Qwen-Image-2.1-Turbo-AD-Q4_K.gguf",
            "bytes": 4201694944,
            "sha256": "4bb73c53cbe284bbd6d69b9fdc59539c531f0389dd2aa567663d777f8130bc59",
            "recommended": true
          },
          {
            "id": "ad_q5_k",
            "label": "AD_Q5_K",
            "filename": "Qwen-Image-2.1-Turbo-AD-Q5_K.gguf",
            "bytes": 5399168736,
            "sha256": "c56db41508c4c3c0d5782e40e4f153c38a1154ac9466c1c5c50a6e4bd09f6a69"
          },
          {
            "id": "ad_q6_k",
            "label": "AD_Q6_K",
            "filename": "Qwen-Image-2.1-Turbo-AD-Q6_K.gguf",
            "bytes": 6711985888,
            "sha256": "aa98b85820544771506b94aa75368a97a457e0d5b569d1a602bde6c64f5a9cfd"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "Qwen-Image-2.1-Turbo-Q8_0.gguf",
            "bytes": 7591554784,
            "sha256": "99f498fb7188be7eac9eb5f345a9e074d30eef3ca235b419e92563e5b48073c4"
          }
        ]
      },
      "vae": {
        "repo": "Comfy-Org/Qwen-Image-2.1",
        "filename": "vae/qwen_image_2.1_vae_bf16.safetensors",
        "bytes": 675509688,
        "sha256": "bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9"
      },
      "text_encoders": [
        {
          "repo": "Qwen/Qwen3-VL-8B-Instruct-GGUF",
          "filename": "Qwen3VL-8B-Instruct-Q4_K_M.gguf",
          "bytes": 5027784800,
          "sha256": "67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2",
          "field": "llm"
        },
        {
          "repo": "Qwen/Qwen3-VL-8B-Instruct-GGUF",
          "filename": "mmproj-Qwen3VL-8B-Instruct-F16.gguf",
          "bytes": 1159029824,
          "sha256": "ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38",
          "field": "llm_vision"
        }
      ],
      "defaults": {
        "steps": 8,
        "cfg_scale": 1,
        "sampling_method": "euler",
        "width": 1024,
        "height": 1024,
        "sigmas": [
          1,
          0.978453,
          0.95418,
          0.926626,
          0.89508,
          0.845148,
          0.704534,
          0.414568
        ]
      },
      "ranges": {
        "steps": [
          1,
          20
        ],
        "dims": [
          256,
          2048
        ],
        "dim_multiple": 32
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": false,
        "workflows": [
          "create",
          "reference",
          "edit"
        ]
      }
    },
    {
      "id": "ltx-2",
      "name": "LTX-2.3 Distilled",
      "developer": "Lightricks",
      "modality": "video",
      "description": "Text-to-video with synchronised audio: the 22B LTX-2.3 distilled checkpoint, 8 steps at guidance 1 on its fixed sigma schedule, 24 fps, clips of 8k+1 frames up to about 10 s. Needs the Gemma-3 12B text encoder (7.4 GB) beside the transformer; about 26 GB of files at Q4_K_M. GGUF packaging by Unsloth.",
      "license": "ltx-2-open-weights",
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "unsloth/LTX-2.3-GGUF",
        "quants": [
          {
            "id": "ud_q3_k_m",
            "label": "UD_Q3_K_M",
            "filename": "distilled/ltx-2.3-22b-distilled-UD-Q3_K_M.gguf",
            "bytes": 13169238048,
            "sha256": "789a9f3737aed51775224d6d567c725d2512d7aa32839b3bbdaba8230af07d77"
          },
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "distilled/ltx-2.3-22b-distilled-Q4_K_M.gguf",
            "bytes": 14326856736,
            "sha256": "4e4459bee04199bf93187ba385729f6b7d8e874d754b72d26e751fe2066f4358",
            "recommended": true
          },
          {
            "id": "ud_q4_k_m",
            "label": "UD_Q4_K_M",
            "filename": "distilled/ltx-2.3-22b-distilled-UD-Q4_K_M.gguf",
            "bytes": 16305131552,
            "sha256": "451ef931569f084c69743d1917096b149eb489517ec0e1de76eaadeb4dbbc9bf"
          },
          {
            "id": "q6_k",
            "label": "Q6_K",
            "filename": "distilled/ltx-2.3-22b-distilled-Q6_K.gguf",
            "bytes": 17774906400,
            "sha256": "f32d8ba8295831815445c42289b9f4deeeede7aab05173b7c51d877b1c2af3d7"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "distilled/ltx-2.3-22b-distilled-Q8_0.gguf",
            "bytes": 22755540000,
            "sha256": "ed3be27373771404ed59239e8c2686fb6f8d3cd6a1db7f257d811c8d1a381ef8"
          }
        ]
      },
      "vae": {
        "repo": "unsloth/LTX-2.3-GGUF",
        "filename": "vae/ltx-2.3-22b-distilled_video_vae.safetensors",
        "bytes": 1452256522,
        "sha256": "e68d6d8f8a42942ac9b862cc315beb3bc30805a8876c7ad63ba5bf7a2b8e168a"
      },
      "audio_vae": {
        "repo": "unsloth/LTX-2.3-GGUF",
        "filename": "vae/ltx-2.3-22b-distilled_audio_vae.safetensors",
        "bytes": 364853140,
        "sha256": "3cd6a6eb8cb28f5ecc12f1f3126952b2a3d2b0b42ad3270e63cefafafe0d9b57"
      },
      "text_encoders": [
        {
          "repo": "unsloth/gemma-3-12b-it-qat-GGUF",
          "filename": "gemma-3-12b-it-qat-UD-Q4_K_XL.gguf",
          "bytes": 7432229248,
          "sha256": "da98f81c86916ed1c76b3eeda56b25cb7b8352b01093e2edb8028110fe2cb53b",
          "field": "llm"
        },
        {
          "repo": "unsloth/LTX-2.3-GGUF",
          "filename": "text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors",
          "bytes": 2312144712,
          "sha256": "c61cbb396e2a8175d8b2da51f0fdac885a4ccd22c9f64dafa5aa2c455dc8a507",
          "field": "embeddings_connectors"
        }
      ],
      "defaults": {
        "steps": 8,
        "cfg_scale": 1,
        "sampling_method": "euler",
        "width": 768,
        "height": 512,
        "sigmas": [
          1,
          0.99375,
          0.9875,
          0.98125,
          0.975,
          0.909375,
          0.725,
          0.421875
        ]
      },
      "ranges": {
        "steps": [
          1,
          50
        ],
        "dims": [
          256,
          1216
        ],
        "dim_multiple": 32
      },
      "video": {
        "fps": 24,
        "frame_step": 8,
        "frame_offset": 1,
        "frames": 121,
        "frame_range": [
          9,
          257
        ],
        "resolution_presets": [
          [
            768,
            512
          ],
          [
            1024,
            576
          ],
          [
            1024,
            768
          ],
          [
            1216,
            704
          ],
          [
            512,
            512
          ],
          [
            768,
            768
          ],
          [
            1024,
            1024
          ],
          [
            512,
            768
          ],
          [
            576,
            1024
          ],
          [
            768,
            1024
          ],
          [
            704,
            1216
          ]
        ]
      },
      "capabilities": {
        "negative_prompt": false,
        "guidance": false,
        "workflows": [
          "create"
        ]
      }
    },
    {
      "id": "wan2.2-ti2v-5b",
      "name": "Wan 2.2 TI2V 5B",
      "developer": "Wan-AI",
      "modality": "video",
      "description": "The small Wan 2.2 text-to-video model: 5B parameters, 24 fps, clips of 4k+1 frames, 720p; a negative prompt and classifier-free guidance apply. Needs the UMT5-XXL text encoder (3.7 GB at Q4_K_M) and the Wan 2.2 VAE beside the transformer; about 8.5 GB of files at Q4_K_M. GGUF packaging by Unsloth; the text encoder by city96.",
      "license": "apache-2.0",
      "engines": [
        "sdcpp"
      ],
      "transformer": {
        "repo": "unsloth/Wan2.2-TI2V-5B-GGUF",
        "quants": [
          {
            "id": "q4_k_m",
            "label": "Q4_K_M",
            "filename": "Wan2.2-TI2V-5B-Q4_K_M.gguf",
            "bytes": 3433116000,
            "sha256": "95b19697b7f98e65b0a543640e9ca7b4dfec32e2a6e3731e8e10708be52655e2",
            "recommended": true
          },
          {
            "id": "q5_k_m",
            "label": "Q5_K_M",
            "filename": "Wan2.2-TI2V-5B-Q5_K_M.gguf",
            "bytes": 3810603360,
            "sha256": "4424633a876511b9be58a41119f7c9d762ea92b3cb74649cdb43cac850e42dba"
          },
          {
            "id": "q6_k",
            "label": "Q6_K",
            "filename": "Wan2.2-TI2V-5B-Q6_K.gguf",
            "bytes": 4211683680,
            "sha256": "355f6bee35c4c6cbd0f275112619fe8ac6f7b9b067b885723667b3bde29497c3"
          },
          {
            "id": "q8_0",
            "label": "Q8_0",
            "filename": "Wan2.2-TI2V-5B-Q8_0.gguf",
            "bytes": 5400179040,
            "sha256": "57bece983817ab2f957546683bb670f13be7d99022d45674840cd999a050ea8f"
          }
        ]
      },
      "vae": {
        "repo": "unsloth/Wan2.2-TI2V-5B-GGUF",
        "filename": "VAE/Wan2.2_VAE.safetensors",
        "bytes": 1409400960,
        "sha256": "e40321bd36b9709991dae2530eb4ac303dd168276980d3e9bc4b6e2b75fed156"
      },
      "text_encoders": [
        {
          "repo": "city96/umt5-xxl-encoder-gguf",
          "filename": "umt5-xxl-encoder-Q4_K_M.gguf",
          "bytes": 3655145312,
          "sha256": "17cf97a5bbbc60a646d6105b832b6f657ce904a8a1ad970e4b59df0c67584a40",
          "field": "t5xxl"
        }
      ],
      "defaults": {
        "steps": 30,
        "cfg_scale": 5,
        "sampling_method": "euler",
        "flow_shift": 5,
        "width": 1280,
        "height": 704
      },
      "ranges": {
        "steps": [
          1,
          100
        ],
        "dims": [
          256,
          1280
        ],
        "dim_multiple": 16
      },
      "video": {
        "fps": 24,
        "frame_step": 4,
        "frame_offset": 1,
        "frames": 121,
        "frame_range": [
          5,
          241
        ],
        "resolution_presets": [
          [
            832,
            480
          ],
          [
            960,
            544
          ],
          [
            1280,
            704
          ],
          [
            704,
            704
          ],
          [
            480,
            832
          ],
          [
            544,
            960
          ],
          [
            704,
            1280
          ]
        ]
      },
      "capabilities": {
        "negative_prompt": true,
        "guidance": false,
        "workflows": [
          "create"
        ]
      }
    }
  ]
};
