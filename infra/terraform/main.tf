terraform {
  required_version = ">= 1.6"

  required_providers {
    google = {
      source  = "hashicorp/google",
      version = "~> 6.0",
    }
  }
}


variable "project_id" {
  type = string
}


variable "region" {
  type    = string
  default = "asia-southeast1"
}


variable "admin_cidr" {
  type = string
}


variable "artifact_bucket" {
  type = string
}


provider "google" {
  project = var.project_id
  region  = var.region
}


resource "google_project_service" "apis" {
  for_each           = toset([
    "container.googleapis.com",
    "compute.googleapis.com",
    "storage.googleapis.com",
    "secretmanager.googleapis.com",
    "file.googleapis.com",
    "sqladmin.googleapis.com"
  ])
  service            = each.key
  disable_on_destroy = false
}


resource "google_compute_network" "tfvn" {
  name                    = "tfvn"
  auto_create_subnetworks = false
  depends_on              = [
    google_project_service.apis,
  ]
}


resource "google_compute_subnetwork" "tfvn" {
  name                     = "tfvn"
  network                  = google_compute_network.tfvn.id
  ip_cidr_range            = "10.40.0.0/20"
  private_ip_google_access = true

  secondary_ip_range {
    range_name    = "pods"
    ip_cidr_range = "10.44.0.0/16"
  }


  secondary_ip_range {
    range_name    = "services"
    ip_cidr_range = "10.45.0.0/20"
  }
}


resource "google_service_account" "nodes" {
  account_id = "tfvn-nodes"
}


resource "google_project_iam_member" "node_logs" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.nodes.email}"
}


resource "google_project_iam_member" "node_metrics" {
  project = var.project_id
  role    = "roles/monitoring.metricWriter"
  member  = "serviceAccount:${google_service_account.nodes.email}"
}


resource "google_container_cluster" "tfvn" {
  name                     = "tfvn"
  location                 = var.region
  network                  = google_compute_network.tfvn.id
  subnetwork               = google_compute_subnetwork.tfvn.id
  remove_default_node_pool = true
  initial_node_count       = 1
  deletion_protection      = true
  networking_mode          = "VPC_NATIVE"
  datapath_provider        = "ADVANCED_DATAPATH"

  release_channel {
    channel = "REGULAR"
  }


  workload_identity_config {
    workload_pool = "${var.project_id}.svc.id.goog"
  }


  ip_allocation_policy {
    cluster_secondary_range_name  = "pods"
    services_secondary_range_name = "services"
  }


  private_cluster_config {
    enable_private_nodes    = true
    enable_private_endpoint = false
    master_ipv4_cidr_block  = "172.20.0.0/28"
  }


  master_authorized_networks_config {
    cidr_blocks {
      cidr_block   = var.admin_cidr
      display_name = "administrators"
    }
  }


  addons_config {
    gcp_filestore_csi_driver_config {
      enabled = true
    }
  }
}


resource "google_container_node_pool" "control" {
  name     = "control"
  cluster  = google_container_cluster.tfvn.name
  location = var.region

  autoscaling {
    total_min_node_count = 2
    total_max_node_count = 4
  }


  node_config {
    machine_type    = "e2-standard-4"
    service_account = google_service_account.nodes.email
    oauth_scopes    = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]
    labels          = {
      tfvn-role = "control",
    }

    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}


resource "google_container_node_pool" "sandbox" {
  name     = "sandbox"
  cluster  = google_container_cluster.tfvn.name
  location = var.region

  autoscaling {
    total_min_node_count = 0
    total_max_node_count = 32
  }


  node_config {
    machine_type    = "e2-standard-4"
    image_type      = "COS_CONTAINERD"
    service_account = google_service_account.nodes.email
    oauth_scopes    = [
      "https://www.googleapis.com/auth/cloud-platform",
    ]
    labels          = {
      tfvn-role = "sandbox",
    }

    taint {
      key    = "tfvn-role"
      value  = "sandbox"
      effect = "NO_SCHEDULE"
    }


    sandbox_config {
      sandbox_type = "gvisor"
    }


    workload_metadata_config {
      mode = "GKE_METADATA"
    }
  }
}


resource "google_compute_router" "tfvn" {
  name    = "tfvn"
  network = google_compute_network.tfvn.id
}


resource "google_compute_router_nat" "tfvn" {
  name                               = "tfvn"
  router                             = google_compute_router.tfvn.name
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}


resource "google_storage_bucket" "artifacts" {
  name                        = var.artifact_bucket
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false

  versioning {
    enabled = true
  }
}


resource "google_service_account" "control" {
  account_id = "tfvn-control"
}


resource "google_service_account_iam_member" "workload_identity" {
  service_account_id = google_service_account.control.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "serviceAccount:${var.project_id}.svc.id.goog[tfvn/tfvn-control]"
}


resource "google_storage_bucket_iam_member" "artifacts" {
  bucket = google_storage_bucket.artifacts.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.control.email}"
}


resource "google_secret_manager_secret" "credentials" {
  for_each  = toset([
    "tfvn-qwen",
    "tfvn-openai",
    "tfvn-anthropic",
    "tfvn-temporal",
    "tfvn-database"
  ])
  secret_id = each.key

  replication {
    auto {

    }
  }

  depends_on = [
    google_project_service.apis,
  ]
}


output "control_service_account" {
  value = google_service_account.control.email
}


output "cluster" {
  value = google_container_cluster.tfvn.name
}
